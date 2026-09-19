import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin"
import type { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { toProjectPath } from "./compile/diagnostics.ts"
import { type CompileResult, compileWithDotnet } from "./compile/dotnet.ts"
import { compileInBatchMode, compileInOpenEditor } from "./compile/editor.ts"
import { listProjectFiles } from "./compile/reconcile.ts"
import { docsDbPath, docsInstalled, docsInstalling, docsStream, indexPackageDocs, installDocs } from "./docs/install.ts"
import { DocsStore } from "./docs/store.ts"
import { Enricher, type SourceReader } from "./enrich.ts"
import { dirFingerprint, ensureGraphDb } from "./graph/build.ts"
import { SymbolGraph } from "./graph/db.ts"
import { checkWrite } from "./guard.ts"
import { lintSource, renderLint } from "./lint.ts"
import { lookup } from "./lookup.ts"
import { loadOptions } from "./options.ts"
import { renderReport } from "./report.ts"
import { AGENT_PROMPT, projectFacts, renderRules } from "./rules.ts"
import { editorCommand, editorConnected, editorHasProjectOpen, spawnCaptured } from "./unity/cli.ts"
import { cacheDir, findEditor, findEditorExecutable, loadProject, type UnityProject } from "./unity/discovery.ts"
import { runTests } from "./unity/tests.ts"
import { writtenPaths } from "./written-paths.ts"

// Assembly-CSharp* holds the user's own scripts: the copy in Library/ is stale as soon as the
// model edits a file, and hints built on stale members would be wrong.
const PROJECT_LAYER_EXCLUDE = /^Assembly-CSharp/

const DOC_PART_CHARS = 6000

type SessionState = {
  failing: boolean
  report: string
  nudges: number
  agent?: string
  model?: { providerID: string; modelID: string }
}

const sourceReader = (projectRoot: string): SourceReader => ({
  text(file) {
    try {
      return fs.readFileSync(path.resolve(projectRoot, file), "utf8")
    } catch {
      return null
    }
  },
})

/** The Unity project at `directory`, above it, or up to two levels below it (monorepos). */
function discoverProject(directory: string): UnityProject | null {
  const direct = loadProject(directory)
  if (direct) return direct
  const visit = (dir: string, depth: number): UnityProject | null => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue
      const child = path.join(dir, entry.name)
      if (fs.existsSync(path.join(child, "ProjectSettings", "ProjectVersion.txt"))) return loadProject(child)
      const nested = depth > 1 ? visit(child, depth - 1) : null
      if (nested) return nested
    }
    return null
  }
  return visit(directory, 2)
}

// opencode calls every export of a plugin module as a plugin: this must stay the only one.
export const UnityPlugin: Plugin = async ({ client, directory }, rawOptions) => {
  const startupProject = discoverProject(directory)
  // Installed globally, the plugin is loaded for every project: stay out of the way elsewhere.
  if (!startupProject) return {}

  const options = loadOptions(directory, rawOptions)
  const projectAt = (dir: string) => loadProject(dir) ?? startupProject

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "opencode-unity", level, message } }).catch(() => {})

  const graphs = new Map<string, { key: string; graph: Promise<SymbolGraph | null> }>()
  const compileQueue = new Map<string, Promise<unknown>>()
  const sessions = new Map<string, SessionState>()
  const session = (id: string) => {
    let state = sessions.get(id)
    if (!state) sessions.set(id, (state = { failing: false, report: "", nudges: 0 }))
    return state
  }

  async function openGraph(project: UnityProject): Promise<SymbolGraph | null> {
    const layers: Database[] = []
    try {
      const editor = findEditor(project.version, { editorPath: options.editorPath })
      if (editor) {
        layers.push(
          await ensureGraphDb({
            dirs: [path.join(editor.managedDir, "UnityEngine")],
            dbPath: path.join(cacheDir(), "symbols", `${project.version}.db`),
            fingerprint: `${project.version}|${editor.managedDir}`,
          }),
        )
      } else {
        void log("warn", `Unity ${project.version} is not installed: API hints are limited to the project packages`)
      }

      const scriptAssemblies = path.join(project.root, "Library", "ScriptAssemblies")
      if (fs.existsSync(scriptAssemblies)) {
        layers.push(
          await ensureGraphDb({
            dirs: [scriptAssemblies],
            exclude: PROJECT_LAYER_EXCLUDE,
            dbPath: path.join(project.root, "Library", "OpencodeUnity", "project-symbols.db"),
            fingerprint: dirFingerprint(scriptAssemblies, PROJECT_LAYER_EXCLUDE),
          }),
        )
      }
    } catch (error) {
      void log("error", `symbol graph unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return layers.length > 0 ? new SymbolGraph(layers) : null
  }

  function graphFor(project: UnityProject): Promise<SymbolGraph | null> {
    const scriptAssemblies = path.join(project.root, "Library", "ScriptAssemblies")
    const key = fs.existsSync(scriptAssemblies) ? dirFingerprint(scriptAssemblies, PROJECT_LAYER_EXCLUDE) : ""
    const cached = graphs.get(project.root)
    if (cached?.key === key) return cached.graph

    const graph = openGraph(project)
    graphs.set(project.root, { key, graph })
    void cached?.graph.then((old) => old?.close())
    return graph
  }

  function openDocs(project: UnityProject): DocsStore {
    let packageDocs: string | null = null
    try {
      packageDocs = indexPackageDocs(project.root)
    } catch (error) {
      void log("warn", `package docs not indexed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return DocsStore.open([docsDbPath(project.version), ...(packageDocs ? [packageDocs] : [])])
  }

  function startDocsInstall(project: UnityProject) {
    installDocs(project.version, (message) => void log("info", `docs ${docsStream(project.version)}: ${message}`)).catch((error) =>
      log("error", `docs install failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }

  const docsHint = (project: UnityProject) =>
    docsInstalling(project.version)
      ? `The Unity ${docsStream(project.version)} manual is still being downloaded and indexed. Try again in a minute.`
      : `The Unity ${docsStream(project.version)} manual is not installed (about 400 MB download). If the user agrees, call unity_docs_install.`

  /** `explicit` = the model asked for a check: prefer Unity's own verdict over the fast approximation. */
  async function compile(project: UnityProject, explicit: boolean, signal?: AbortSignal): Promise<CompileResult> {
    const run = { timeoutMs: options.compileTimeoutMs, signal }
    const hasProjects = listProjectFiles(project.root).length > 0
    const backend = options.compileBackend ?? "auto"

    const wantEditor = backend === "editor" || (backend === "auto" && (explicit || !hasProjects))
    if (wantEditor && (await editorConnected(project.root, { signal }))) return compileInOpenEditor(project, run)
    if (hasProjects || backend === "dotnet") return compileWithDotnet(project.root, run)
    if (explicit && !editorHasProjectOpen(project.root)) return compileInBatchMode(project, options.editorPath, run)
    return compileWithDotnet(project.root, run) // reports why nothing can be compiled
  }

  function lintReport(project: UnityProject, files: string[]): string {
    if (options.lint === false) return ""
    const inputHandler = projectFacts(project).inputHandler
    const findings = files.flatMap((file) => {
      const relative = toProjectPath(file, project.root)
      const source = sourceReader(project.root).text(relative)
      return source === null ? [] : lintSource(source, { file: relative, inputHandler }).map((finding) => ({ file: relative, finding }))
    })
    return renderLint(findings)
  }

  /** One build at a time per project: concurrent MSBuild runs fight over Temp/obj. */
  function compileAndReport(project: UnityProject, editedFiles: string[], explicit: boolean, signal?: AbortSignal) {
    const previous = compileQueue.get(project.root) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        const [result, graph] = await Promise.all([compile(project, explicit, signal), graphFor(project)])
        const enricher = graph ? new Enricher(graph, sourceReader(project.root)) : null
        const report = renderReport(result, {
          editedFiles: editedFiles.map((f) => toProjectPath(f, project.root)),
          hints: (d) => enricher?.hints(d) ?? [],
          maxErrors: options.maxErrors,
        })
        const lint = lintReport(project, editedFiles)
        return { failing: result.status === "errors", report: lint ? `${report}\n\n${lint}` : report }
      })
    compileQueue.set(project.root, next)
    return next
  }

  // Warm up front: the first graph build takes a few seconds and should not land on the first edit.
  void graphFor(startupProject)
  if (options.docs === "auto" && !docsInstalled(startupProject.version)) startDocsInstall(startupProject)

  const hooks: Hooks = {
    "tool.execute.before": async (input, output) => {
      for (const file of writtenPaths(input.tool, output.args, directory)) {
        const project = loadProject(file)
        if (!project) continue
        const rule = checkWrite(toProjectPath(file, project.root), options.allow)
        if (rule) throw new Error(`[unity] Blocked: ${toProjectPath(file, project.root)}. ${rule.reason}`)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (options.compileOnEdit === false) return
      const scripts = writtenPaths(input.tool, input.args, directory).filter((f) => f.toLowerCase().endsWith(".cs"))
      const project = scripts.length > 0 ? loadProject(scripts[0]!) : null
      if (!project) return

      try {
        const { failing, report } = await compileAndReport(project, scripts, false)
        output.output = `${output.output}\n\n${report}`
        Object.assign(session(input.sessionID), { failing, report })
      } catch (error) {
        void log("error", `compile check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    "chat.message": async (input) => {
      // A new user message: the idle gate gets a fresh budget, and remembers who to answer as.
      Object.assign(session(input.sessionID), { nudges: 0, agent: input.agent, model: input.model })
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") sessions.delete(event.properties.info.id)
      if (event.type !== "session.idle" || options.idleGate === false) return

      const state = sessions.get(event.properties.sessionID)
      if (!state?.failing || state.nudges >= (options.idleGateRetries ?? 2)) return
      state.nudges++
      await client.session
        .promptAsync({
          path: { id: event.properties.sessionID },
          body: {
            agent: state.agent,
            model: state.model,
            parts: [{ type: "text", text: `You stopped, but the Unity project does not compile. Fix these errors now, then stop.\n\n${state.report}` }],
          },
        })
        .catch((error: unknown) => log("error", `idle gate could not re-prompt: ${String(error)}`))
    },

    tool: {
      unity_compile: tool({
        description:
          "Compile the Unity project's C# scripts and return the compiler errors, each with the real Unity API that fixes it. Run it whenever you are unsure the code builds.",
        args: {},
        async execute(_args, context) {
          const { failing, report } = await compileAndReport(projectAt(context.directory), [], true, context.abort)
          Object.assign(session(context.sessionID), { failing, report })
          return report
        },
      }),

      unity_lookup: tool({
        description:
          'Look up a Unity type or member in the exact Unity version of this project: real signatures, overloads, what replaces an obsolete API, and an example. Spelling can be approximate. Examples: "Rigidbody", "Rigidbody.AddForce", "transform setparent", "FindObjectOfType". Use it BEFORE writing code that calls an API you are not 100% sure about.',
        args: { name: tool.schema.string().describe('Type or Type.Member, e.g. "Rigidbody.AddForce"') },
        async execute(args, context) {
          const project = projectAt(context.directory)
          const graph = await graphFor(project)
          if (!graph) return "[unity] The API index is not available (Unity Editor or .NET SDK not found). Use unity_docs_search instead."
          const docs = openDocs(project)
          try {
            return lookup(graph, args.name, (page) => docs.example(page))
          } finally {
            docs.close()
          }
        },
      }),

      unity_docs_search: tool({
        description:
          'Search the official Unity Manual, Scripting Reference and the documentation of the installed packages, offline, for this project\'s Unity version. Use it for "how do I..." questions. Returns page ids to open with unity_docs_read.',
        args: { query: tool.schema.string().describe('A few keywords, e.g. "coroutine wait seconds"') },
        async execute(args, context) {
          const project = projectAt(context.directory)
          const docs = openDocs(project)
          try {
            const hits = docs.search(args.query)
            const missing = docsInstalled(project.version) ? "" : `\n\n(${docsHint(project)})`
            if (hits.length === 0) return `No documentation page matches '${args.query}'. Try fewer or different keywords.${missing}`
            const lines = hits.map((h, i) => `${i + 1}) [${h.kind}] ${h.title}\n   page: ${h.path}\n   ${h.snippet.slice(0, 220)}`)
            return `${lines.join("\n")}\n\n→ unity_docs_read("${hits[0]!.path}")${missing}`
          } finally {
            docs.close()
          }
        },
      }),

      unity_docs_read: tool({
        description: "Read one Unity documentation page found with unity_docs_search. Long pages come in parts.",
        args: {
          page: tool.schema.string().describe('Page id from unity_docs_search, e.g. "Manual/class-Rigidbody" or "Rigidbody.AddForce"'),
          part: tool.schema.number().int().min(1).optional().describe("Part number for long pages (default 1)"),
        },
        async execute(args, context) {
          const project = projectAt(context.directory)
          const docs = openDocs(project)
          try {
            const page = docs.page(args.page)
            if (!page) return `No page '${args.page}'. ${docsInstalled(project.version) ? "Find the right id with unity_docs_search." : docsHint(project)}`
            const parts = Math.max(1, Math.ceil(page.body.length / DOC_PART_CHARS))
            const part = Math.min(args.part ?? 1, parts)
            const text = page.body.slice((part - 1) * DOC_PART_CHARS, part * DOC_PART_CHARS)
            const more = part < parts ? `\n\n→ part ${part} of ${parts}. Next: unity_docs_read("${page.path}", ${part + 1})` : ""
            return `${page.title}  (${page.path})\n\n${text}${more}`
          } finally {
            docs.close()
          }
        },
      }),

      unity_docs_install: tool({
        description:
          "Download and index the offline Unity documentation for this project's Unity version (about 400 MB, one time). Only call this when the user has asked for it or agreed to it.",
        args: {},
        async execute(_args, context) {
          const project = projectAt(context.directory)
          if (docsInstalled(project.version)) return `The Unity ${docsStream(project.version)} documentation is already installed.`
          if (!docsInstalling(project.version)) startDocsInstall(project)
          return `Started downloading the Unity ${docsStream(project.version)} documentation in the background. unity_docs_search will use it as soon as it is ready (usually a few minutes).`
        },
      }),

      unity_test: tool({
        description:
          "Run the Unity project's automated tests (Unity Test Framework) and return the failures. Works through the open Editor when the Pipeline package is installed, otherwise needs the Editor closed. Can take minutes.",
        args: {
          mode: tool.schema.enum(["EditMode", "PlayMode"]).describe("EditMode for plain logic tests, PlayMode for tests that need the game running"),
          filter: tool.schema.string().optional().describe("Only run tests whose name contains this text"),
        },
        async execute(args, context) {
          return runTests(projectAt(context.directory), args.mode, args.filter, options.editorPath, { signal: context.abort })
        },
      }),

      unity_console: tool({
        description:
          "Read the Console of the open Unity Editor: runtime errors, exceptions and warnings with their stack traces. Use it after the user has pressed Play and reports that something does not work.",
        args: {
          level: tool.schema.enum(["error", "warn", "log"]).optional().describe("Minimum severity (default error)"),
          count: tool.schema.number().int().min(1).max(50).optional().describe("How many recent entries (default 15)"),
        },
        async execute(args, context) {
          const project = projectAt(context.directory)
          if (!(await editorConnected(project.root, { signal: context.abort }))) {
            return "[unity] No Unity Editor with the Pipeline package is connected for this project, so its Console cannot be read. Ask the user to paste the Console output, or to run `unity pipeline install` in the project and reopen it."
          }
          const response = await editorCommand(project.root, "console", { level: args.level ?? "error", tail: args.count ?? 15 }, { signal: context.abort })
          if (!response.success) return `[unity] Console could not be read: ${response.errors[0]?.message ?? "unknown error"}`
          const result = (response.data as { result?: { entries?: { level: string; message: string; stackTrace?: string }[] } } | null)?.result
          const entries = result?.entries ?? []
          if (entries.length === 0) return `[unity] The Editor Console has no entries at level '${args.level ?? "error"}' or above.`
          return entries
            .map((e, i) => {
              const stack = (e.stackTrace ?? "").split("\n").filter(Boolean).slice(0, 5).map((l) => `     ${l.trim()}`)
              return [`${i + 1}) [${e.level}] ${e.message.trim()}`, ...stack].join("\n")
            })
            .join("\n")
        },
      }),
    },

    config: async (config) => {
      if (options.agent === false) return
      config.agent = {
        ...config.agent,
        "unity-coder": {
          description: "Unity C# coding with compile checks and API lookup. Pair it with a small/local model.",
          mode: "primary",
          temperature: 0.2,
          prompt: AGENT_PROMPT,
          ...config.agent?.["unity-coder"],
        },
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (options.rules === false) return
      output.system.push(renderRules(projectFacts(startupProject)))
    },
  }

  const allowedMethods = options.executeMethods ?? []
  if (allowedMethods.length > 0) {
    hooks.tool!.unity_run_method = tool({
      description: `Run one of the project's Editor automation methods in Unity batch mode (the Editor must be closed). Allowed methods: ${allowedMethods.join(", ")}`,
      args: { method: tool.schema.string().describe("Fully qualified static method name, exactly as listed") },
      async execute(args, context) {
        const project = projectAt(context.directory)
        if (!allowedMethods.includes(args.method)) return `[unity] '${args.method}' is not allowed. Allowed methods: ${allowedMethods.join(", ")}`
        if (editorHasProjectOpen(project.root)) return "[unity] The Unity Editor has this project open: batch mode cannot start. Ask the user to close the Editor or to run the method from its menu."
        const editor = findEditor(project.version, { editorPath: options.editorPath })
        const executable = editor ? findEditorExecutable(editor.root) : null
        if (!executable) return `[unity] Unity ${project.version} is not installed.`

        const logFile = path.join(project.root, "Logs", `opencode-unity-${Date.now()}.log`)
        fs.mkdirSync(path.dirname(logFile), { recursive: true })
        const result = await spawnCaptured(
          [executable, "-batchmode", "-quit", "-nographics", "-projectPath", project.root, "-executeMethod", args.method, "-logFile", logFile],
          { timeoutMs: 1_800_000, signal: context.abort },
        )
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-25).join("\n") : ""
        return `[unity] ${args.method} exited with code ${result.exitCode}.\n\nEnd of the Editor log:\n${tail}`
      },
    })
  }

  return hooks
}

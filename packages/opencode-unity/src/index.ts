import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import { toProjectPath } from "./compile/diagnostics.ts"
import { type CompileResult, compileWithDotnet } from "./compile/dotnet.ts"
import { compileInBatchMode, compileInOpenEditor } from "./compile/editor.ts"
import { listProjectFiles, walkScripts } from "./compile/reconcile.ts"
import { docsDbPath, docsInstalled, docsInstalling, docsStream, indexPackageDocs, installDocs } from "./docs/install.ts"
import { DocsStore } from "./docs/store.ts"
import { Enricher, type SourceReader } from "./enrich.ts"
import { dirFingerprint, ensureGraphDb } from "./graph/build.ts"
import { SymbolGraph } from "./graph/db.ts"
import { checkWrite } from "./guard.ts"
import { lintSource, renderLint } from "./lint.ts"
import { lookup } from "./lookup.ts"
import { loadOptions } from "./options.ts"
import type { Database } from "./sqlite.ts"
import { renderReport } from "./report.ts"
import { AGENT_PROMPT, projectFacts, renderRules } from "./rules.ts"
import { renderStatus, startupLine } from "./status.ts"
import { run as runProcess } from "./runtime.ts"
import { editScene, type PipelineCall, viewScene } from "./scene.ts"
import { sceneTools } from "./scene-tools.ts"
import { commandResult, editorCommand, editorConnected, editorHasProjectOpen, findUnityCli } from "./unity/cli.ts"
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

  const NO_EDITOR =
    "[unity] This works through the open Unity Editor, and no Editor with the Pipeline package is connected for this project. Call unity_status to see what is missing. If the package is not installed, ask the user whether to install it, then call unity_pipeline_install. If it is installed, ask the user to open the project in Unity. Do NOT write an Editor script to build the scene instead, and do not edit the .unity file."

  const PIPELINE_WAIT_MS = 120_000

  // A small model that gets an error sometimes resends the identical call, forever. Repeating a
  // failed call cannot succeed, so the answer escalates, and from the third time on the call is
  // not even executed: every failed attempt also leaves an error in the user's Unity Console.
  const repeats = new Map<string, { input: string; count: number; output: string }>()
  function breakLoop(sessionID: string, toolName: string, input: unknown, output: string, failed: boolean): string {
    const key = `${sessionID}:${toolName}`
    const text = JSON.stringify(input)
    const previous = repeats.get(key)
    if (!failed) {
      repeats.delete(key)
      return output
    }
    const same = previous?.input === text
    const entry = { input: text, count: same ? previous.count + 1 : 1, output: same ? previous.output : output }
    repeats.set(key, entry)
    if (entry.count === 2) return `${output}\n\nYou sent EXACTLY the same call as last time, so it failed for the same reason. Change the call before trying again.`
    if (entry.count >= 3) {
      return `[unity] STOP. This exact call has now failed ${entry.count} times in a row and was NOT executed again. Do not call ${toolName} again in this turn. Tell the user, in plain words, what you were trying to do and the error below, and wait for their answer.\n\n${entry.output}`
    }
    return output
  }
  function stuck(sessionID: string, toolName: string, input: unknown): string | null {
    const previous = repeats.get(`${sessionID}:${toolName}`)
    return previous && previous.count >= 2 && previous.input === JSON.stringify(input) ? breakLoop(sessionID, toolName, input, previous.output, true) : null
  }

  /** Everything the scene tools need from the open Editor, or null when none is connected. */
  async function connectScene(dir: string, signal: AbortSignal) {
    const project = projectAt(dir)
    if (!(await editorConnected(project.root, { signal }))) return null
    return {
      graph: await graphFor(project),
      scripts: new Set([...walkScripts(path.join(project.root, "Assets"))].map((file) => path.basename(file, ".cs"))),
      call: pipeline(project, signal),
      assetExists: (asset: string) => fs.existsSync(path.join(project.root, asset)),
      readAsset: (asset: string) => sourceReader(project.root).text(asset),
    }
  }

  const pipeline =
    (project: UnityProject, signal?: AbortSignal): PipelineCall =>
    async (command, params = {}) =>
      commandResult(await editorCommand(project.root, command, params, { signal, timeoutMs: 60_000 }))

  // Say so once: a plugin that works silently looks exactly like one that never loaded.
  void log("info", startupLine(startupProject))
  void client.tui
    .showToast({ body: { title: "opencode-unity", message: `Active on Unity ${startupProject.version}. /unity shows the status.`, variant: "success", duration: 4000 } })
    .catch(() => {})

  // Warm up front: the first graph build takes a few seconds and should not land on the first edit.
  void graphFor(startupProject)
  if (options.docs === "auto" && !docsInstalled(startupProject.version)) startDocsInstall(startupProject)

  // Small models break nested JSON arguments, so by default they get one flat tool per action.
  // The batch tool (several operations in one transaction) suits stronger models. Decided here
  // because unity_scene_view has to point at the editing tools the mode actually registers.
  const sceneMode = options.sceneTools ?? "simple"

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
      unity_status: tool({
        description: "Show whether the opencode-unity plugin is active on this project and which compile, test, docs and Editor routes are available. Return its output to the user unchanged.",
        args: {},
        async execute(_args, context) {
          return renderStatus(projectAt(context.directory), options, context.abort)
        },
      }),

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

      unity_pipeline_install: tool({
        description:
          "Install Unity's Pipeline package (com.unity.pipeline) into this project. It is what lets you edit scenes, read the Editor Console, run tests and compile inside the open Editor. It changes Packages/manifest.json, so the user is asked to approve. Call it when unity_status says the package is not installed and the user wants those features.",
        args: {},
        async execute(_args, context) {
          const project = projectAt(context.directory)
          if (await editorConnected(project.root)) return "[unity] The Pipeline package is already installed and connected. Nothing to do."

          const cli = findUnityCli()
          if (!cli) {
            return "[unity] The Unity CLI (`unity`) is not installed, and it is what installs the package. Tell the user to install the Unity CLI, or to add the package in the Editor: Window > Package Manager > + > Install package by name > com.unity.pipeline."
          }

          try {
            await context.ask({
              permission: "unity_pipeline_install",
              patterns: [project.root],
              always: [project.root],
              metadata: { package: "com.unity.pipeline", changes: "Packages/manifest.json", project: project.root },
            })
          } catch {
            return "[unity] The user did not approve installing the Pipeline package. Do not try again unless they ask."
          }

          const result = await runProcess([cli, "pipeline", "install", "--project-path", project.root], {
            timeoutMs: 180_000,
            signal: context.abort,
            env: { UNITY_NO_BANNER: "1", UNITY_NON_INTERACTIVE: "1", UNITY_NO_PAGER: "1" },
          })
          if (result.exitCode !== 0) return `[unity] Installing the Pipeline package failed:\n${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(-8).join("\n")}`

          if (!editorHasProjectOpen(project.root)) {
            return "[unity] Pipeline package added to Packages/manifest.json. Ask the user to open the project in Unity: the package is imported on startup, then scene editing, Console and tests become available (check with unity_status)."
          }

          // The open Editor imports the package when it next refreshes, which needs its window focused.
          const deadline = Date.now() + PIPELINE_WAIT_MS
          while (Date.now() < deadline && !context.abort.aborted) {
            if (await editorConnected(project.root)) return "[unity] Pipeline package installed and connected. unity_scene_view, unity_scene_edit, unity_console and unity_test now work through the open Editor."
            await new Promise((resolve) => setTimeout(resolve, 3_000))
          }
          return "[unity] Pipeline package added to Packages/manifest.json, but the open Editor has not loaded it yet. Ask the user to click on the Unity window so it imports the package, then check with unity_status."
        },
      }),

      unity_scene_view: tool({
        description:
          "Look at the scene that is open in the Unity Editor. Without arguments: the hierarchy as a tree with each object's components. With a path: every component of that object and its current values. Always look before editing.",
        args: { path: tool.schema.string().optional().describe('Hierarchy path of one object, e.g. "/Player/Gun". Omit for the whole scene.') },
        async execute(args, context) {
          const project = projectAt(context.directory)
          if (!(await editorConnected(project.root, { signal: context.abort }))) return NO_EDITOR
          return viewScene(pipeline(project, context.abort), args.path, { flatTools: sceneMode !== "batch" })
        },
      }),

      unity_scene_edit: tool({
        description: [
          "Create and change objects in the scene open in the Unity Editor. Use this instead of writing Editor scripts or editing .unity files.",
          "All operations are checked first and applied together. If one is wrong, nothing changes. The user can undo the whole call with Ctrl+Z.",
          "Each operation is one flat JSON object. Every key is a plain word followed by its value. Objects are addressed by hierarchy path.",
          "Examples, one operation per line:",
          '{"op":"create","name":"Car","position":[0,1,0]}',
          '{"op":"create","name":"Body","parent":"/Car","primitive":"cube","scale":[1.2,0.5,2.2],"color":"#E53935"}',
          '{"op":"create","name":"Wheel_FL","parent":"/Car","primitive":"cylinder","position":[-0.6,-0.25,0.8],"scale":[0.5,0.1,0.5],"color":"#000000"}',
          '{"op":"create","name":"Player","primitive":"capsule","tag":"Player","components":["Rigidbody","PlayerController"]}',
          '{"op":"set","target":"/Player","component":"Rigidbody","values":{"mass":2,"useGravity":false}}',
          '{"op":"set","target":"/CameraRig","component":"CameraFollow","values":{"target":"/Car","offset":[0,3,-6]}}',
          '{"op":"add_component","target":"/Car","type":"BoxCollider","values":{"isTrigger":true}}',
          '{"op":"modify","target":"/Car","position":[0,2,0],"rotation":[0,90,0],"tag":"Player","layer":"Default","active":true}',
          '{"op":"modify","target":"/Old","parent":"/World","name":"Renamed"}',
          '{"op":"remove_component","target":"/Car","type":"BoxCollider"}',
          '{"op":"delete","target":"/Old"}',
          '{"op":"instantiate","prefab":"Assets/Prefabs/Enemy.prefab","name":"Enemy1","position":[3,0,0]}',
          "The primitive shapes are cube, sphere, capsule, cylinder, plane and quad. Leave primitive out for an empty object.",
          "A color is a hex string or three numbers from 0 to 1. It creates a material and assigns it.",
          "Values are plain JSON. Write 1500, true, [0,3,-6]. Never wrap a value in an object.",
          "A value that points to another object is its hierarchy path. A value that points to an asset is its path starting with Assets/.",
          "For a thing made of parts, create an empty parent first and put the scaled shapes inside it as children.",
          "Your own scripts can be added as components only after their .cs file exists and the compile report passed.",
          "Send a few operations per call, not the whole scene at once.",
        ].join("\n"),
        args: {
          operations: tool.schema
            .array(
              // Typed so the model sees the fields; loose so a shape mistake still reaches the normalizer.
              tool.schema.looseObject({
                // Advertised as a string enum, validated as anything: a nested {"op": {...}} must reach
                // the normalizer instead of bouncing off schema validation with a generic message.
                op: tool.schema
                  .any()
                  .meta({ type: "string", enum: ["create", "modify", "add_component", "remove_component", "set", "delete", "instantiate"], description: "What to do. A plain string, never an object" }),
                target: tool.schema.string().optional().describe('Hierarchy path of an existing object, for example /Player/Gun. Not used by create and instantiate'),
                name: tool.schema.string().optional().describe("Name of the new object. With modify, the new name"),
                primitive: tool.schema.enum(["cube", "sphere", "capsule", "cylinder", "plane", "quad"]).optional().describe("Built-in shape for create. Leave out for an empty object"),
                parent: tool.schema.string().optional().describe('Hierarchy path of the parent object, for example /Car'),
                position: tool.schema.array(tool.schema.number()).optional().describe("[x, y, z] local position"),
                rotation: tool.schema.array(tool.schema.number()).optional().describe("[x, y, z] Euler angles in degrees"),
                scale: tool.schema.array(tool.schema.number()).optional().describe("[x, y, z] local scale"),
                tag: tool.schema.string().optional(),
                layer: tool.schema.string().optional(),
                active: tool.schema.boolean().optional(),
                color: tool.schema.any().optional().meta({ description: 'Plain color for an object that has a mesh, as a hex string such as #E53935 or three numbers from 0 to 1. A material is created and assigned for you' }),
                components: tool.schema.array(tool.schema.string()).optional().describe('Component class names to add when creating, for example ["Rigidbody", "PlayerController"]'),
                type: tool.schema.string().optional().describe("Component class name for add_component and remove_component"),
                component: tool.schema.string().optional().describe("Component class name whose values are changed by set"),
                values: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe('Property names and their new values as plain JSON. A number is written 1500, a switch true or false, a vector [0,3,-6], a reference "/Car". Never wrap a value in an object. Example {"mass": 1500, "useGravity": true, "target": "/Car"}'),
                prefab: tool.schema.string().optional().describe('Asset path of the prefab for instantiate, for example Assets/Prefabs/Enemy.prefab'),
              }),
            )
            .min(1)
            .max(60)
            .describe('Ordered list of FLAT operation objects, e.g. [{"op":"create","name":"Ground","primitive":"plane","scale":[10,1,10]}]'),
          save: tool.schema.boolean().optional().describe("Save the scene afterwards (default false: the user reviews first)"),
        },
        async execute(args, context) {
          const repeated = stuck(context.sessionID, "unity_scene_edit", args)
          if (repeated) return repeated
          const editor = await connectScene(context.directory, context.abort)
          if (!editor) return NO_EDITOR
          const output = await editScene(editor, { operations: args.operations, save: args.save })
          return breakLoop(context.sessionID, "unity_scene_edit", args, output, output.includes("NOT changed"))
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
            return `${NO_EDITOR} Meanwhile, ask the user to paste the Console output.`
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
      config.command = {
        ...config.command,
        unity: {
          description: "opencode-unity: is the plugin active, and what can it do on this project?",
          template: "Call the unity_status tool and show me its output exactly as returned, in a code block. Do nothing else.",
          ...config.command?.unity,
        },
      }
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

  if (sceneMode === "simple") delete hooks.tool!.unity_scene_edit
  if (sceneMode !== "batch") Object.assign(hooks.tool!, sceneTools({ connect: connectScene, notConnected: NO_EDITOR, breakLoop, stuck }))

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
        const result = await runProcess(
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

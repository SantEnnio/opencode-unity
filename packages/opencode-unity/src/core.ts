// Everything the plugin does, with no knowledge of opencode: host-v1.ts and host-v2.ts connect it
// to the two plugin APIs.

import { arg, defineTool, optional, type ToolSpec } from "./args.ts"
import fs from "node:fs"
import path from "node:path"
import { toProjectPath } from "./compile/diagnostics.ts"
import { type CompileResult, compileWithDotnet } from "./compile/dotnet.ts"
import { applyUpgrades, upgradesFrom } from "./compile/upgrade.ts"
import { compileInBatchMode, compileInOpenEditor } from "./compile/editor.ts"
import { listProjectFiles, walkScripts } from "./compile/reconcile.ts"
import { docsDbPath, docsIndexing, docsReady, editorDocsDir, ensureEditorDocs, indexPackageDocs } from "./docs/editor.ts"
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
import { sceneTools, touchedPaths } from "./scene-tools.ts"
import { installProbe, PROBE_VERSION, probeState, rememberObjects } from "./probe/package.ts"
import { parseKeys } from "./probe/keys.ts"
import { objectTimeline, playNote, probeDir, readRun, runReport } from "./probe/report.ts"
import { commandResult, editorCommand, editorConnected, editorHasProjectOpen, findUnityCli } from "./unity/cli.ts"
import { cacheDir, findEditor, findEditorExecutable, loadProject, type UnityProject } from "./unity/discovery.ts"
import { PORT_TAKEN, pipelineState, readDescriptor } from "./unity/pipeline.ts"
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
  /** Who the user last spoke to, so the idle gate answers as the same agent (opencode 1) */
  agent?: string
  model?: { providerID: string; modelID: string }
  /** The last play the model was told about, and for how many more user turns */
  seenRun?: string
  note?: string
  noteTurns?: number
  /** The user message the play note goes with */
  noteMessage?: string
  /** Project-relative scripts the model wrote in this session: the only ones unity_update_api touches */
  written?: Set<string>
  /** Unity renames still to make in those scripts, from the last compile */
  upgrades?: number
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const UPDATE_API_NEXT = (count: number) =>
  `→ Next: call unity_update_api. It makes Unity's own rename for ${count === 1 ? "this obsolete call" : `these ${count} obsolete calls`}, so Unity does not stop on its API Updater dialog.`

// A play note is only about a game the user has just played.
const NOTE_MAX_AGE_MS = 30 * 60_000
const NOTE_TURNS = 2

export type Log = (level: "info" | "warn" | "error", message: string) => void

/** What the core asks of the host. */
export type Host = {
  /** Registers the tools again, after the set changed (opencode 2 can, opencode 1 cannot) */
  reloadTools?: () => void | Promise<void>
}

export const UNITY_COMMAND = {
  name: "unity",
  description: "opencode-unity: is the plugin active, and what can it do on this project?",
  template: "Call the unity_status tool and show me its output exactly as returned, in a code block. Do nothing else.",
}

export const UNITY_AGENT = {
  name: "unity-coder",
  description: "Unity C# coding with compile checks and API lookup. Pair it with a small/local model.",
  temperature: 0.2,
}

export type Unity = ReturnType<typeof createUnityCore>

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

// The fields of one unity_scene_edit operation. Typed so the model sees them; loose so a shape
// mistake still reaches the normalizer in scene.ts, which answers with the right form.
type OperationField = { kind: "string" | "numbers" | "strings" | "boolean" | "any" | "values"; description?: string; enum?: string[] }
const OPERATION_FIELDS: Record<string, OperationField> = {
  // Advertised as a string enum, validated as anything: a nested {"op": {...}} must reach the
  // normalizer instead of bouncing off schema validation with a generic message.
  op: { kind: "any", enum: ["create", "modify", "add_component", "remove_component", "set", "delete", "instantiate"], description: "What to do. A plain string, never an object" },
  target: { kind: "string", description: "Hierarchy path of an existing object, for example /Player/Gun. Not used by create and instantiate" },
  name: { kind: "string", description: "Name of the new object. With modify, the new name" },
  primitive: { kind: "string", enum: ["cube", "sphere", "capsule", "cylinder", "plane", "quad"], description: "Built-in shape for create. Leave out for an empty object" },
  parent: { kind: "string", description: "Hierarchy path of the parent object, for example /Car" },
  position: { kind: "numbers", description: "[x, y, z] local position" },
  rotation: { kind: "numbers", description: "[x, y, z] Euler angles in degrees" },
  scale: { kind: "numbers", description: "[x, y, z] local scale" },
  tag: { kind: "string" },
  layer: { kind: "string" },
  active: { kind: "boolean" },
  color: { kind: "any", description: "Plain color for an object that has a mesh, as a hex string such as #E53935 or three numbers from 0 to 1. A material is created and assigned for you" },
  components: { kind: "strings", description: 'Component class names to add when creating, for example ["Rigidbody", "PlayerController"]' },
  type: { kind: "string", description: "Component class name for add_component and remove_component" },
  component: { kind: "string", description: "Component class name whose values are changed by set" },
  values: { kind: "values", description: 'Property names and their new values as plain JSON. A number is written 1500, a switch true or false, a vector [0,3,-6], a reference "/Car". Never wrap a value in an object. Example {"mass": 1500, "useGravity": true, "target": "/Car"}' },
  prefab: { kind: "string", description: "Asset path of the prefab for instantiate, for example Assets/Prefabs/Enemy.prefab" },
}

function operationJsonSchema(): Record<string, unknown> {
  const kinds = {
    string: { type: "string" },
    numbers: { type: "array", items: { type: "number" } },
    strings: { type: "array", items: { type: "string" } },
    boolean: { type: "boolean" },
    any: {},
    values: { type: "object", additionalProperties: true },
  }
  return Object.fromEntries(
    Object.entries(OPERATION_FIELDS).map(([name, f]) => {
      // An enum on "any" is advice for the model, not a constraint: it goes into the description.
      const enumeration = f.enum && f.kind !== "any" ? { enum: f.enum } : {}
      const description = f.kind === "any" && f.enum ? `${f.description}. One of: ${f.enum.join(", ")}` : f.description
      return [name, { ...kinds[f.kind], ...enumeration, ...(description && { description }) }]
    }),
  )
}

function operationZodShape(z: any): Record<string, any> {
  return Object.fromEntries(
    Object.entries(OPERATION_FIELDS).map(([name, f]) => {
      let schema: any
      if (f.kind === "any") schema = z.any().optional().meta({ ...(f.enum && { type: "string", enum: f.enum }), ...(f.description && { description: f.description }) })
      else {
        if (f.kind === "string") schema = f.enum ? z.enum(f.enum) : z.string()
        else if (f.kind === "numbers") schema = z.array(z.number())
        else if (f.kind === "strings") schema = z.array(z.string())
        else if (f.kind === "boolean") schema = z.boolean()
        else schema = z.record(z.string(), z.any())
        schema = schema.optional()
        if (f.description) schema = schema.describe(f.description)
      }
      return [name, schema]
    }),
  )
}

/** Null outside a Unity project: installed globally, the plugin must stay out of the way elsewhere. */
export function createUnity(directory: string, rawOptions: unknown, log: Log, host: Host = {}) {
  const startupProject = discoverProject(directory)
  return startupProject ? createUnityCore(directory, startupProject, rawOptions, log, host) : null
}

function createUnityCore(directory: string, startupProject: UnityProject, rawOptions: unknown, log: Log, host: Host) {
  const options = loadOptions(directory, rawOptions)
  const projectAt = (dir: string) => loadProject(dir) ?? startupProject

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

  /**
   * The Unity documentation is the Editor's own Documentation module. Returns null when its index
   * is ready, otherwise what to tell the model, and starts indexing when the module is there.
   */
  function docsProblem(project: UnityProject): string | null {
    const editor = findEditor(project.version, { editorPath: options.editorPath })
    const dir = editor ? editorDocsDir(editor.root) : null
    if (!editor) return `Unity ${project.version} is not installed, so its manual is not available. For API questions use unity_lookup.`
    if (!dir) {
      return `The Unity ${project.version} manual is not installed. Ask the user to add it in Unity Hub: Installs, the menu of Unity ${project.version}, Add modules, Documentation. Meanwhile, for API questions use unity_lookup.`
    }
    if (docsReady(project.version, dir)) return null
    if (!docsIndexing(project.version)) indexDocs(project.version, dir)
    return `The Unity ${project.version} manual is being indexed (about half a minute, once). Try again shortly.`
  }

  function indexDocs(version: string, dir: string) {
    ensureEditorDocs(version, dir, (message) => log("info", `docs ${version}: ${message}`))
      .then((pages) => log("info", `docs ${version}: ${pages} pages indexed from ${dir}`))
      .catch((error) => log("error", `docs index failed: ${error instanceof Error ? error.message : String(error)}`))
  }

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
        const edited = new Set(editedFiles.map((f) => toProjectPath(f, project.root)))
        const upgrades = "diagnostics" in result ? upgradesFrom(result.diagnostics).filter((u) => edited.has(u.file)) : []
        const next = upgrades.length > 0 ? `\n\n${UPDATE_API_NEXT(upgrades.length)}` : ""
        return { failing: result.status === "errors", report: `${lint ? `${report}\n\n${lint}` : report}${next}`, upgrades: upgrades.length }
      })
    compileQueue.set(project.root, next)
    return next
  }

  const NO_EDITOR =
    "[unity] This works through the open Unity Editor, and no Editor with the Pipeline package is connected for this project. Call unity_status to see what is missing. If the package is not installed, ask the user whether to install it, then call unity_pipeline_install. If it is installed, ask the user to open the project in Unity. Do NOT write an Editor script to build the scene instead, and do not edit the .unity file."

  /** Why the Editor cannot be used: usually not open or no Pipeline package, sometimes another Editor on its port. */
  async function noEditor(dir: string): Promise<string> {
    const root = projectAt(dir).root
    if ((await pipelineState(root)) === "port-taken") {
      // A small model stops at "does not work" unless it is told what still does.
      const play = probeState(root) === "current" ? ", and running the game with unity_play new_run true (it does not need that port)" : ""
      return `[unity] ${PORT_TAKEN(readDescriptor(root)?.port ?? 0)}. Still working: reading and editing scripts${play}. Tell the user about the other Unity project in one sentence, then carry on with what still works. Do NOT write an Editor script to work around it, and do not edit the .unity file.`
    }
    return NO_EDITOR
  }

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
  log("info", startupLine(startupProject))

  // Warm up front: the first graph build takes a few seconds and should not land on the first edit.
  void graphFor(startupProject)
  // Nothing to download: if the Editor has its Documentation module, index it in the background now.
  docsProblem(startupProject)

  // Small models break nested JSON arguments, so by default they get one flat tool per action.
  // The batch tool (several operations in one transaction) suits stronger models. Decided here
  // because unity_scene_view has to point at the editing tools the mode actually registers.
  const sceneMode = options.sceneTools ?? "simple"

  /** A reason to refuse a file tool call that would write where Unity owns the file, or null. */
  function guardWrite(toolName: string, args: unknown, dir = directory): string | null {
    for (const file of writtenPaths(toolName, args, dir)) {
      const project = loadProject(file)
      if (!project) continue
      const rule = checkWrite(toProjectPath(file, project.root), options.allow)
      if (rule) return `[unity] Blocked: ${toProjectPath(file, project.root)}. ${rule.reason}`
    }
    return null
  }

  /** The compile report to append to a file tool's result when it wrote C#, or null. */
  async function afterWrite(toolName: string, args: unknown, sessionID: string, dir = directory): Promise<string | null> {
    if (options.compileOnEdit === false) return null
    const scripts = writtenPaths(toolName, args, dir).filter((f) => f.toLowerCase().endsWith(".cs"))
    const project = scripts.length > 0 ? loadProject(scripts[0]!) : null
    if (!project) return null
    try {
      const { failing, report, upgrades } = await compileAndReport(project, scripts, false)
      const state = session(sessionID)
      state.written ??= new Set()
      for (const file of scripts) state.written.add(toProjectPath(file, project.root))
      Object.assign(state, { failing, report, upgrades })
      return report
    } catch (error) {
      log("error", `compile check failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * A new user message: the idle gate gets a fresh budget, and remembers who to answer as. If the
   * user has just played, the play note goes with this message and the next one, then is dropped.
   */
  function userMessage(sessionID: string, who: { agent?: string; model?: { providerID: string; modelID: string } } = {}, messageID?: string) {
    const state = session(sessionID)
    Object.assign(state, { nudges: 0, ...who })
    const run = probeState(startupProject.root) === "missing" ? null : readRun(startupProject.root)
    // A test play started by unity_play was already returned to the model as the tool's result.
    const fresh = run !== null && run.startedBy !== "agent" && run.id !== state.seenRun && Date.now() - Date.parse(run.endedAt) < NOTE_MAX_AGE_MS
    if (fresh) Object.assign(state, { seenRun: run.id, note: playNote(run), noteTurns: NOTE_TURNS, noteMessage: messageID })
    else if (state.noteTurns) state.noteTurns--
  }

  /**
   * The play note for this session's next model request, and the user message it goes with. The
   * host adds it to that one request only: it is never stored, so it never piles up in the context.
   */
  function playNoteFor(sessionID: string): { text: string; messageID?: string } | null {
    const state = sessions.get(sessionID)
    return state?.note && state.noteTurns ? { text: state.note, messageID: state.noteMessage } : null
  }

  /** The session stopped. Returns the message that sends the model back while the build is red, or null. */
  function idle(sessionID: string): { text: string; agent?: string; model?: { providerID: string; modelID: string } } | null {
    if (options.idleGate === false) return null
    const state = sessions.get(sessionID)
    if (!state || (!state.failing && !state.upgrades) || state.nudges >= (options.idleGateRetries ?? 2)) return null
    state.nudges++
    if (!state.failing) {
      return {
        text: `You stopped, but the scripts you wrote still use ${state.upgrades} obsolete Unity API call(s), and Unity will stop on its API Updater dialog for them. Call unity_update_api, then stop.`,
        agent: state.agent,
        model: state.model,
      }
    }
    return {
      text: `You stopped, but the Unity project does not compile. Fix these errors now, then stop.\n\n${state.report}`,
      agent: state.agent,
      model: state.model,
    }
  }

  const tools: Record<string, ToolSpec<any>> = {
    unity_status: defineTool({
      description: "Show whether the opencode-unity plugin is active on this project and which compile, test, docs and Editor routes are available. Return its output to the user unchanged.",
      args: {},
      async execute(_args, context) {
        return renderStatus(projectAt(context.directory), options, context.abort)
      },
    }),

    unity_compile: defineTool({
      description:
        "Compile the Unity project's C# scripts and return the compiler errors, each with the real Unity API that fixes it. Run it whenever you are unsure the code builds.",
      args: {},
      async execute(_args, context) {
        const { failing, report } = await compileAndReport(projectAt(context.directory), [], true, context.abort)
        Object.assign(session(context.sessionID), { failing, report })
        return report
      },
    }),

    unity_update_api: defineTool({
      description:
        "Make Unity's own renames of obsolete API in the scripts you wrote, for example rb.velocity to rb.linearVelocity, so Unity does not stop on its API Updater dialog. Call it when a compile report says so. It shows every line it changed.",
      args: {},
      async execute(_args, context) {
        const project = projectAt(context.directory)
        const state = session(context.sessionID)
        const files = [...(state.written ?? [])]
        if (files.length === 0) return "[unity] You have not written any script in this session, so there is nothing to update."
        if (listProjectFiles(project.root).length === 0) {
          return "[unity] This needs the C# project files Unity generates, and there are none. Ask the user to pick a code editor in Unity, Preferences > External Tools, then click Regenerate project files."
        }
        const before = await compileWithDotnet(project.root, { timeoutMs: options.compileTimeoutMs, signal: context.abort })
        if (!("diagnostics" in before)) return `[unity] The scripts could not be compiled to find obsolete API: ${before.reason}`
        const upgrades = upgradesFrom(before.diagnostics).filter((u) => files.includes(u.file))
        if (upgrades.length === 0) {
          state.upgrades = 0
          return "[unity] No obsolete Unity API to update in the scripts you wrote."
        }
        const changed = applyUpgrades(project.root, upgrades)
        const after = await compileAndReport(project, files.map((f) => path.resolve(project.root, f)), false, context.abort)
        Object.assign(state, { failing: after.failing, report: after.report, upgrades: after.upgrades })
        const lines = new Map<string, string>()
        for (const c of changed) lines.set(`${c.file}:${c.line}`, `- ${c.file}:${c.line}\n    was: ${c.before}\n    now: ${c.after}`)
        return [
          `[unity] Updated ${plural(changed.length, "obsolete API call")}: the same renames Unity's API Updater would make.`,
          ...lines.values(),
          "These files changed on disk. In any later edit, use these lines as they are now.",
          "",
          after.report,
        ].join("\n")
      },
    }),

    unity_lookup: defineTool({
      description:
        'Look up a Unity type or member in the exact Unity version of this project: real signatures, overloads, what replaces an obsolete API, and an example. Spelling can be approximate. Examples: "Rigidbody", "Rigidbody.AddForce", "transform setparent", "FindObjectOfType". Use it BEFORE writing code that calls an API you are not 100% sure about.',
      args: { name: arg.string('Type or Type.Member, e.g. "Rigidbody.AddForce"') },
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

    unity_docs_search: defineTool({
      description:
        'Search the official Unity Manual, Scripting Reference and the documentation of the installed packages, offline, for this project\'s Unity version. Use it for "how do I..." questions. Returns page ids to open with unity_docs_read.',
      args: { query: arg.string('A few keywords, e.g. "coroutine wait seconds"') },
      async execute(args, context) {
        const project = projectAt(context.directory)
        const docs = openDocs(project)
        try {
          const hits = docs.search(args.query)
          const problem = docsProblem(project)
          const missing = problem ? `\n\n(${problem})` : ""
          if (hits.length === 0) return `No documentation page matches '${args.query}'. Try fewer or different keywords.${missing}`
          const lines = hits.map((h, i) => `${i + 1}) [${h.kind}] ${h.title}\n   page: ${h.path}\n   ${h.snippet.slice(0, 220)}`)
          return `${lines.join("\n")}\n\n→ unity_docs_read("${hits[0]!.path}")${missing}`
        } finally {
          docs.close()
        }
      },
    }),

    unity_docs_read: defineTool({
      description: "Read one Unity documentation page found with unity_docs_search. Long pages come in parts.",
      args: {
        page: arg.string('Page id from unity_docs_search, e.g. "Manual/class-Rigidbody" or "Rigidbody.AddForce"'),
        part: optional(arg.number("Part number for long pages (default 1)", { integer: true, min: 1 })),
      },
      async execute(args, context) {
        const project = projectAt(context.directory)
        const docs = openDocs(project)
        try {
          const page = docs.page(args.page)
          if (!page) return `No page '${args.page}'. ${docsProblem(project) ?? "Find the right id with unity_docs_search."}`
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

    unity_pipeline_install: defineTool({
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

        const refused = await context.consent({
          permission: "unity_pipeline_install",
          question: `Install Unity's Pipeline package (com.unity.pipeline) into ${project.root}? It adds one line to Packages/manifest.json.`,
          patterns: [project.root],
          metadata: { package: "com.unity.pipeline", changes: "Packages/manifest.json", project: project.root },
        })
        if (refused) return refused

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

    unity_scene_view: defineTool({
      description:
        "Look at the scene that is open in the Unity Editor. Without arguments: the hierarchy as a tree with each object's components. With a path: every component of that object and its current values. Always look before editing.",
      args: { path: optional(arg.string('Hierarchy path of one object, e.g. "/Player/Gun". Omit for the whole scene.')) },
      async execute(args, context) {
        const project = projectAt(context.directory)
        if (!(await editorConnected(project.root, { signal: context.abort }))) return noEditor(context.directory)
        return viewScene(pipeline(project, context.abort), args.path, { flatTools: sceneMode !== "batch" })
      },
    }),

    unity_scene_edit: defineTool({
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
        "A value that points to an object or to one of its components is the hierarchy path of that object, also when it is the object being changed. A value that points to an asset is its path starting with Assets/.",
        "For a thing made of parts, create an empty parent first and put the scaled shapes inside it as children.",
        "Your own scripts can be added as components only after their .cs file exists and the compile report passed.",
        "Send a few operations per call, not the whole scene at once.",
      ].join("\n"),
      args: {
        operations: arg.raw<Record<string, unknown>[]>(
          { type: "array", minItems: 1, maxItems: 60, items: { type: "object", properties: operationJsonSchema(), additionalProperties: true } },
          (z) => z.array(z.looseObject(operationZodShape(z))).min(1).max(60),
          'Ordered list of FLAT operation objects, e.g. [{"op":"create","name":"Ground","primitive":"plane","scale":[10,1,10]}]',
        ),
        save: optional(arg.boolean("Save the scene afterwards (default false: the user reviews first)")),
      },
      async execute(args, context) {
        const repeated = stuck(context.sessionID, "unity_scene_edit", args)
        if (repeated) return repeated
        const editor = await connectScene(context.directory, context.abort)
        if (!editor) return noEditor(context.directory)
        const output = await editScene(editor, { operations: args.operations, save: args.save })
        if (!output.includes("NOT changed")) rememberObjects(projectAt(context.directory).root, args.operations.flatMap((op) => touchedPaths(op)))
        return breakLoop(context.sessionID, "unity_scene_edit", args, output, output.includes("NOT changed"))
      },
    }),

    unity_test: defineTool({
      description:
        "Run the Unity project's automated tests (Unity Test Framework) and return the failures. Works through the open Editor when the Pipeline package is installed, otherwise needs the Editor closed. Can take minutes.",
      args: {
        mode: arg.enum(["EditMode", "PlayMode"], "EditMode for plain logic tests, PlayMode for tests that need the game running"),
        filter: optional(arg.string("Only run tests whose name contains this text")),
      },
      async execute(args, context) {
        return runTests(projectAt(context.directory), args.mode, args.filter, options.editorPath, { signal: context.abort })
      },
    }),

    unity_console: defineTool({
      description:
        "Read the Console of the open Unity Editor: runtime errors, exceptions and warnings with their stack traces. Use it after the user has pressed Play and reports that something does not work.",
      args: {
        level: optional(arg.enum(["error", "warn", "log"], "Minimum severity (default error)")),
        count: optional(arg.number("How many recent entries (default 15)", { integer: true, min: 1, max: 50 })),
      },
      async execute(args, context) {
        const project = projectAt(context.directory)
        if (!(await editorConnected(project.root, { signal: context.abort }))) {
          return `${await noEditor(context.directory)} Meanwhile, ask the user to paste the Console output.`
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
  }

  if (sceneMode === "simple") delete tools.unity_scene_edit
  if (sceneMode !== "batch") {
    Object.assign(tools, sceneTools({ connect: connectScene, notConnected: noEditor, breakLoop, stuck, touched: (dir, paths) => rememberObjects(projectAt(dir).root, paths) }))
  }

  // The runtime probe's tools cost context, so each one exists only while it is useful.
  const probeTools = {
    unity_probe_install: defineTool({
      description:
        "Add the opencode-unity runtime probe to this Unity project. It records what the game does in Play mode (errors, how objects move, collisions, keys) so you can see it with unity_play. Editor only, nothing goes into builds. Call it when the user agrees.",
      args: {},
      async execute(_args, context) {
        const project = projectAt(context.directory)
        const state = probeState(project.root)
        if (state === "current") return `[unity] The runtime probe ${PROBE_VERSION} is already installed. Use unity_play.`
        const refused = await context.consent({
          permission: "unity_probe_install",
          question: `${state === "outdated" ? "Update" : "Add"} the opencode-unity runtime probe in ${project.root}/Packages? It is Editor only and records what the game does in Play mode.`,
          patterns: [project.root],
          metadata: { package: "com.opencode-unity.probe", project: project.root },
        })
        if (refused) return refused
        installProbe(project.root)
        await host.reloadTools?.()
        return `[unity] Runtime probe ${PROBE_VERSION} added to Packages/. Unity imports it when its window gets focus. From now on every Play is recorded: ask the user to press Play, try the game and press Stop${host.reloadTools ? ", then call unity_play." : ". Restart opencode to get the unity_play tool."}`
      },
    }),

    unity_play: defineTool({
      description:
        'What the game does in the Unity Editor, recorded by the runtime probe: errors, how the main objects moved, collisions, keys and input actions. Without arguments: the last play. With a path: that object\'s timeline in the last play. With new_run true: runs the game now for 5 seconds with nobody pressing keys, then reports it. With keys: runs the game now and presses those keys, for example keys "W 2s; Space" to test moving and jumping. Then check with path whether the player moved.',
      args: {
        path: optional(arg.string('Hierarchy path of one object, e.g. "/Player". Omit for the whole run.')),
        new_run: optional(arg.boolean("true to run the game now instead of reading the last play")),
        keys: optional(arg.string('Keys to press in a new run, in order, e.g. "W 2s; Space; W+D 1s; wait 1s". A time after the keys holds them; without it, a quick tap')),
      },
      async execute(args, context) {
        const project = projectAt(context.directory)
        if (args.new_run === true || args.keys?.trim()) {
          const failed = await testPlay(project, context.sessionID, context.abort, args.keys?.trim() || undefined)
          if (failed) return failed
        }
        const run = readRun(project.root)
        if (!run) return "[unity] No play recorded yet. Call unity_play with new_run true, or ask the user to press Play in Unity, try the game, then press Stop."
        return args.path?.trim() ? objectTimeline(run, args.path) : runReport(run)
      },
    }),
  }

  const TEST_PLAY_SECONDS = 5
  // Entering Play reloads scripts (about 7 s measured), compiling can come first, then the run itself.
  const TEST_PLAY_WAIT_MS = 120_000

  /**
   * Asks the probe for a test play and waits for its recording. Returns why it could not run, or
   * null once last-run.json answers this request. The probe starts and stops Play itself, so this
   * works without the Pipeline package; with it, the Editor is also told to play right away.
   */
  async function testPlay(project: UnityProject, sessionID: string, signal: AbortSignal, keys?: string): Promise<string | null> {
    if (probeState(project.root) !== "current") return "[unity] The runtime probe in this project is out of date and cannot start a test play. Call unity_probe_install to update it."
    const script = keys ? parseKeys(keys) : null
    if (typeof script === "string") return `[unity] Game NOT run: ${script}`
    if (script && projectFacts(project).inputHandler === 0) {
      return "[unity] Game NOT run: this project reads the keyboard through the old Input Manager (UnityEngine.Input), and keys cannot be pressed for it. Call unity_play with new_run true to run it without keys, and ask the user to test the controls."
    }
    if (!editorHasProjectOpen(project.root)) return "[unity] Unity is not open with this project, so the game cannot run. Ask the user to open the project in Unity, then call unity_play with new_run true again."
    if (sessions.get(sessionID)?.failing) return "[unity] The project does not compile, so the game cannot run. Fix the compile errors first (unity_compile), then call unity_play with new_run true again."

    const connected = await editorConnected(project.root, { signal })
    if (connected) {
      const status = await editorCommand(project.root, "editor_status", {}, { signal, timeoutMs: 15_000 })
      const playMode = (status.data as { result?: { playMode?: string } } | null)?.result?.playMode
      if (playMode === "playing") return "[unity] The game is already playing in Unity: the user is probably testing it. Wait until they press Stop, then call unity_play without arguments to read that play."
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const request = path.join(probeDir(project.root), "request.json")
    fs.mkdirSync(path.dirname(request), { recursive: true })
    // Keys start 0.5 s in; the game keeps running 1.5 s after the last one to show what it caused.
    const seconds = script ? Math.min(30, Math.max(TEST_PLAY_SECONDS, Math.ceil(0.5 + script.total + 1.5))) : TEST_PLAY_SECONDS
    fs.writeFileSync(request, JSON.stringify({ id, seconds, ...(script && { steps: script.steps, script: script.text }) }))
    if (connected) void editorCommand(project.root, "editor_play", {}, { signal, timeoutMs: 60_000 }).catch(() => {})

    const deadline = Date.now() + TEST_PLAY_WAIT_MS
    const refusal = path.join(probeDir(project.root), "refused.json")
    while (Date.now() < deadline && !signal.aborted) {
      if (readRun(project.root)?.requestId === id) return null
      try {
        const refused = JSON.parse(fs.readFileSync(refusal, "utf8")) as { id?: string; reason?: string }
        if (refused.id === id) {
          return refused.reason === "compile"
            ? "[unity] Game NOT run: Unity says the scripts do not compile, and it refuses to play. Call unity_compile, fix the errors, then call unity_play again."
            : "[unity] The user is playing the game in Unity right now. Wait until they press Stop, then call unity_play without arguments to read that play."
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    fs.rmSync(request, { force: true })
    return signal.aborted
      ? "[unity] Test play cancelled."
      : "[unity] Unity did not run the game within two minutes. It is probably in the background and busy, or showing a dialog. Ask the user to click on the Unity window, then call unity_play with new_run true again."
  }

  /** The tools to register now: the probe ones depend on whether the probe is in the project. */
  function activeTools(): Record<string, ToolSpec<any>> {
    const state = probeState(startupProject.root)
    return {
      ...tools,
      ...(state !== "current" && { unity_probe_install: probeTools.unity_probe_install }),
      ...(state !== "missing" && { unity_play: probeTools.unity_play }),
    }
  }

  const allowedMethods = options.executeMethods ?? []
  if (allowedMethods.length > 0) {
    tools.unity_run_method = defineTool({
      description: `Run one of the project's Editor automation methods in Unity batch mode (the Editor must be closed). Allowed methods: ${allowedMethods.join(", ")}`,
      args: { method: arg.string("Fully qualified static method name, exactly as listed") },
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

  return {
    project: startupProject,
    options,
    get tools() {
      return activeTools()
    },
    guardWrite,
    afterWrite,
    userMessage,
    playNote: playNoteFor,
    idle,
    forget: (sessionID: string) => sessions.delete(sessionID),
    /** The always-on rules block for the system prompt, or null when switched off. */
    rules: () => (options.rules === false ? null : renderRules(projectFacts(startupProject))),
    agent: options.agent === false ? null : { ...UNITY_AGENT, prompt: AGENT_PROMPT },
  }
}

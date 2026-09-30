// Scene editing through the open Editor (Unity CLI + Pipeline package). The model describes what
// it wants as a short list of operations; everything is validated here first, then applied as one
// transactional batch: either all of it lands as a single Undo step, or the scene is untouched.
//
// This file is the only place that knows the Pipeline package's command names and shapes.

import { similarity } from "./enrich.ts"
import type { SymbolGraph } from "./graph/db.ts"

export type SceneOp = {
  op: string
  target?: string
  name?: string
  primitive?: string
  parent?: string
  position?: number[]
  rotation?: number[]
  scale?: number[]
  tag?: string
  layer?: string
  active?: boolean
  components?: string[]
  type?: string
  component?: string
  values?: Record<string, unknown>
  prefab?: string
  color?: number[] | string
  /** Fields that could not be understood: reported, never silently dropped */
  unknown?: string[]
}

export type HierarchyNode = { name: string; hierarchyPath: string; activeSelf?: boolean; components: string[]; children: HierarchyNode[] }
export type Hierarchy = { sceneName: string; scenePath: string; isDirty: boolean; roots: HierarchyNode[] }
export type PipelineOp = { command: string; params: Record<string, unknown> }

/** Transport to the Editor. `null` result + error text on failure. */
export type PipelineCall = (command: string, params?: Record<string, unknown>) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>

export type EditRequest = { operations: unknown[]; save?: boolean; dryRun?: boolean }

type BatchResult = { results: { command: string; success: boolean; error?: string; skipped?: boolean; result?: unknown }[]; applied: number; reverted?: boolean }

const PRIMITIVES = ["cube", "sphere", "capsule", "cylinder", "plane", "quad"]

/**
 * Components Unity marks [DisallowMultipleComponent]. The symbol graph has no attributes, so this
 * is a pragmatic list of the ones a model actually adds twice (a real session added a second
 * Rigidbody to a wheel). Being short is safe: a type that is missing here just falls through to
 * Unity as before. Colliders are absent on purpose — several on one object are legitimate.
 */
const SINGLE_INSTANCE = new Set([
  "Rigidbody",
  "Rigidbody2D",
  "Animator",
  "Animation",
  "Camera",
  "AudioListener",
  "CharacterController",
  "MeshFilter",
  "MeshRenderer",
  "SkinnedMeshRenderer",
  "SpriteRenderer",
  "LineRenderer",
  "TrailRenderer",
  "Canvas",
  "NavMeshAgent",
])
const OPS = ["create", "modify", "add_component", "remove_component", "set", "delete", "instantiate"]
const MAX_TREE_LINES = 200

// ---------------------------------------------------------------- helpers

const normalizePath = (p: string) => `/${p.trim().replace(/^\/+|\/+$/g, "")}`

function suggest(wanted: string, candidates: Iterable<string>, limit = 4): string[] {
  return [...candidates]
    .map((c) => ({ c, score: similarity(c.slice(c.lastIndexOf("/") + 1), wanted.slice(wanted.lastIndexOf("/") + 1)) }))
    .filter((x): x is { c: string; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.c)
}

/** "m_UseGravity" -> "useGravity": the name a programmer would type. */
export function friendlyName(serialized: string): string {
  const bare = serialized.replace(/^m_|^_+/, "")
  return bare.charAt(0).toLowerCase() + bare.slice(1)
}

const propertyKey = (name: string) => name.replace(/^m_|^_+/, "").toLowerCase()

/**
 * Maps the name the model used to the serialized property Unity expects. Built-in components
 * serialize as m_Mass, and some kept their old name after an API rename (linearDamping is still
 * m_Drag in 6000.0), which is where the obsolete -> replacement edges of the graph come in.
 */
export function resolveProperty(wanted: string, available: string[], aliases: (name: string) => string[] = () => []): string | null {
  if (available.includes(wanted)) return wanted
  const byKey = new Map(available.map((name) => [propertyKey(name), name]))
  for (const candidate of [wanted, ...aliases(wanted)]) {
    const match = byKey.get(propertyKey(candidate))
    if (match) return match
  }
  return null
}

function flatten(nodes: HierarchyNode[], into = new Map<string, Set<string>>()): Map<string, Set<string>> {
  for (const node of nodes) {
    into.set(node.hierarchyPath, new Set(node.components))
    flatten(node.children ?? [], into)
  }
  return into
}

const COLOR_NAMES: Record<string, string> = {
  red: "#E53935", green: "#43A047", blue: "#1E88E5", yellow: "#FDD835", orange: "#FB8C00", purple: "#8E24AA", pink: "#EC407A",
  brown: "#6D4C41", black: "#111111", white: "#FFFFFF", gray: "#808080", grey: "#808080", darkgray: "#424242", darkgrey: "#424242",
  lightgray: "#BDBDBD", lightgrey: "#BDBDBD", cyan: "#00ACC1", magenta: "#D81B60", gold: "#FFC107", silver: "#C0C0C0",
}

/** [r,g,b], [r,g,b,a] (0-1, or 0-255 when any channel is above 1) or "#RRGGBB[AA]" -> [r,g,b,a] in 0-1. */
export function parseColor(value: unknown): number[] | null {
  // Seen live: {"color:": {"#000000}}, {": ": {"}}. The color is in there, wrapped in junk.
  if (isRecord(value)) {
    const hex = /#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/i.exec(JSON.stringify(value))?.[0]
    return hex ? parseColor(hex) : null
  }
  if (typeof value === "string") {
    const named = COLOR_NAMES[value.trim().toLowerCase().replace(/[\s_-]/g, "")]
    if (named) return parseColor(named)
    const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim())
    if (!hex) {
      // "0.2, 0.4, 1" or "220 30 30"
      const numbers = value.match(/-?\d*\.?\d+/g)?.map(Number)
      return numbers && (numbers.length === 3 || numbers.length === 4) ? parseColor(numbers) : null
    }
    const channels = (hex[1]! + (hex[2] ?? "ff")).match(/../g)!
    return channels.map((c) => Number((parseInt(c, 16) / 255).toFixed(4)))
  }
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4) || !value.every((n) => typeof n === "number" && n >= 0)) return null
  const scale = value.some((n) => n > 1) ? 255 : 1
  const [r, g, b, a = scale] = value as number[]
  return [r!, g!, b!, a].map((n) => Number((n / scale).toFixed(4)))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const isVector = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && value.every((n) => typeof n === "number") && (length === undefined || value.length === length)

const isHandle = (value: unknown) => typeof value === "object" && value !== null && "instanceId" in value

/** Why a serialized YAML asset cannot be imported, or null when it looks sane. */
export function corruptAsset(text: string | null): string | null {
  if (text === null || !text.startsWith("%YAML")) return null
  const ids = [...text.matchAll(/^--- !u!\d+ &(-?\d+)/gm)].map((m) => m[1]!)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate) return `it contains two objects with the same id (&${duplicate})`
  const badGuid = [...text.matchAll(/guid: ([^,}\s]+)/g)].map((m) => m[1]!).find((guid) => !/^[0-9a-f]{32}$/.test(guid))
  return badGuid ? `it references an invalid GUID (${badGuid})` : null
}

const HANDLE_KEYS = ["path", "guid", "globalId", "instanceId", "hierarchyPath"]

const reference = (text: string) => (/^(Assets|Packages)\//.test(text) ? { path: text } : { hierarchyPath: normalizePath(text) })

/**
 * Object-reference fields take a handle. The model may pass "/Path", "Assets/x.mat", {ref},
 * {asset}, a real handle, or an object with some invented key around the path: anything else is
 * refused here, because a handle Unity rejects also leaves an error in the user's Console.
 */
function toValue(raw: unknown, current: unknown): unknown {
  const value = unwrapTyped(raw)
  const referenceField = current === null || isHandle(current)
  if (isRecord(value)) {
    if (typeof value.ref === "string") return { hierarchyPath: normalizePath(value.ref) }
    if (typeof value.asset === "string") return { path: value.asset }
    if (!referenceField) return coerce(value, current)
    if (HANDLE_KEYS.some((key) => key in value)) return value
    const texts = Object.values(value).filter((v): v is string => typeof v === "string" && v.length > 0)
    if (texts.length === 1) return reference(texts[0]!)
    throw new Error(`is an object reference: give it the hierarchy path of a scene object ("/Player") or an asset path ("Assets/Materials/Red.mat"), not ${JSON.stringify(value).slice(0, 120)}`)
  }
  if (referenceField) return typeof value === "string" && value.length > 0 ? reference(value) : value
  return coerce(value, current)
}

/**
 * Seen live: {"mass": {"$float": 1500}}, {"useGravity": {"$bool": true}}, {"offset": {"$vector3": [0,3,-6]}}.
 * With no type information for a value, a model invents a typed wrapper. One-key objects whose key
 * looks like a type tag, and {type, value} pairs, are unwrapped.
 */
export function unwrapTyped(value: unknown): unknown {
  if (!isRecord(value)) return value
  const keys = Object.keys(value)
  if (keys.length === 1 && /^\$|^(float|double|int|integer|number|bool|boolean|string|enum|vector[234]?|color|value)$/i.test(keys[0]!)) return unwrapTyped(value[keys[0]!])
  if ("value" in value && keys.every((k) => k === "value" || k === "type")) return unwrapTyped(value.value)
  return value
}

/** Shapes the value like the property it replaces, or explains what that property needs. */
function coerce(value: unknown, current: unknown): unknown {
  const example = JSON.stringify(current)
  if (typeof current === "number") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value
    if (typeof number === "number" && Number.isFinite(number)) return number
    throw new Error(`is a number: write it bare, like ${example}, not ${JSON.stringify(value).slice(0, 80)}`)
  }
  if (typeof current === "boolean") {
    if (typeof value === "boolean") return value
    if (value === "true" || value === "false") return value === "true"
    throw new Error(`is true or false, written bare, not ${JSON.stringify(value).slice(0, 80)}`)
  }
  if (Array.isArray(current) && current.every((n) => typeof n === "number")) {
    const vector = toVector4(value)
    if (isVector(vector) && vector.length === current.length) return vector
    throw new Error(`is a list of ${current.length} numbers, like ${example}, not ${JSON.stringify(value).slice(0, 80)}`)
  }
  if (typeof current === "string") {
    if (typeof value === "string") return value
    throw new Error(`is a text value, like ${example}, not ${JSON.stringify(value).slice(0, 80)}`)
  }
  return value
}

function toVector4(value: unknown): unknown {
  if (!isRecord(value)) return value
  const axes = ["x", "y", "z", "w"].filter((axis) => typeof value[axis] === "number")
  if (axes.length >= 2) return axes.map((axis) => value[axis])
  const channels = ["r", "g", "b", "a"].filter((c) => typeof value[c] === "number")
  return channels.length >= 3 ? channels.map((c) => value[c]) : value
}

// ---------------------------------------------------------------- input shapes

const OP_SYNONYMS: Record<string, string> = {
  add: "add_component",
  addcomponent: "add_component",
  removecomponent: "remove_component",
  update: "modify",
  edit: "modify",
  move: "modify",
  transform: "modify",
  rename: "modify",
  set_transform: "modify",
  set_properties: "set",
  set_component_properties: "set",
  remove: "delete",
  destroy: "delete",
  spawn: "instantiate",
  new: "create",
  create_gameobject: "create",
}

const FIELDS = ["target", "name", "primitive", "parent", "position", "rotation", "scale", "tag", "layer", "active", "components", "type", "component", "values", "prefab", "color"]


function toVector(value: unknown): unknown {
  if (isRecord(value) && ["x", "y", "z"].every((axis) => typeof value[axis] === "number")) return [value.x, value.y, value.z]
  return value
}

/**
 * Small models get the nesting wrong far more often than the content: {"create": {...}},
 * {"op": {"create": {...}}}, {"op": {...}}, "set" used for a transform. Everything that can be
 * understood is accepted, so a call is never wasted on a shape mistake.
 */
export function normalizeOp(raw: unknown): SceneOp {
  return normalizeOps(raw)[0]!
}

/** One raw entry can hide more than one operation (see the junk-key case below). */
export function normalizeOps(raw: unknown): SceneOp[] {
  if (!isRecord(raw)) return [{ op: String(raw) }]
  const hoisted: SceneOp[] = []
  let fields: Record<string, unknown> = { ...raw }
  let verb: unknown = fields.op ?? fields.action ?? fields.operation ?? fields.command
  for (const key of ["op", "action", "operation", "command"]) delete fields[key]

  // {"op": {"create": {...}}} or {"op": {...fields}}
  if (isRecord(verb)) {
    fields = { ...verb, ...fields }
    verb = undefined
  }
  // {"create": {...}}
  if (typeof verb !== "string") {
    const key = Object.keys(fields).find((k) => isRecord(fields[k]) && (OPS.includes(k) || k.toLowerCase() in OP_SYNONYMS))
    if (key) {
      const inner = fields[key] as Record<string, unknown>
      delete fields[key]
      fields = { ...inner, ...fields }
      verb = key
    }
  }

  let op = typeof verb === "string" ? verb.trim().toLowerCase() : ""
  op = OP_SYNONYMS[op.replace(/[\s-]/g, "_")] ?? OP_SYNONYMS[op.replace(/[\s_-]/g, "")] ?? op.replace(/[\s-]/g, "_")

  for (const key of ["path", "object", "gameObject", "gameobject"]) {
    if (fields.target === undefined && typeof fields[key] === "string") fields.target = fields[key]
  }
  if (fields.values === undefined && isRecord(fields.properties)) fields.values = fields.properties
  // Misspelled keys ("primitive:", "Position") are repaired; a stray wrapper object is unwrapped
  // when it holds known fields; whatever is left is reported instead of being dropped.
  const unknown: string[] = []
  for (const key of Object.keys(fields)) {
    if (FIELDS.includes(key) || key === "properties") continue
    const value = fields[key]
    delete fields[key]
    const letters = key.replace(/[^A-Za-z_]/g, "").toLowerCase()
    const repaired = FIELDS.find((field) => field === letters)
    // A degenerating model emits keys like ": {" or "op: ". A whole operation under such a key is
    // kept as its own operation; pure punctuation, or a second copy of "op", carries nothing.
    if (isRecord(value) && (typeof value.op === "string" || isRecord(value.op))) {
      hoisted.push(...normalizeOps(value))
    } else if (letters === "" || letters === "op") {
      continue
    } else if (isRecord(value) && Object.keys(value).some((inner) => FIELDS.includes(inner))) {
      for (const [inner, innerValue] of Object.entries(value)) if (fields[inner] === undefined) fields[inner] = innerValue
    } else if (repaired && fields[repaired] === undefined) {
      fields[repaired] = value
    } else if (!["path", "object", "gameObject", "gameobject"].includes(key)) {
      unknown.push(key)
    } else {
      fields[key] = value
    }
  }
  if (unknown.length > 0) fields.unknown = unknown
  for (const key of ["position", "rotation", "scale"]) fields[key] = toVector(fields[key])
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key]

  const hasValues = isRecord(fields.values) && (fields.component !== undefined || fields.type !== undefined)
  if (!op) op = fields.prefab ? "instantiate" : fields.target ? (hasValues ? "set" : "modify") : fields.name ? "create" : ""
  // "set" with a transform and no component is a modify.
  if (op === "set" && !hasValues && (fields.position || fields.rotation || fields.scale || fields.tag || fields.layer || fields.parent !== undefined)) op = "modify"

  return [{ ...(fields as Omit<SceneOp, "op">), op }, ...hoisted]
}

const EXAMPLE = '{"op":"create","name":"Ground","primitive":"plane","position":[0,0,0],"scale":[10,1,10]}'

// ---------------------------------------------------------------- view

function renderTree(nodes: HierarchyNode[], depth: number, lines: string[]) {
  for (const node of nodes) {
    if (lines.length >= MAX_TREE_LINES) return
    const components = node.components.filter((c) => c !== "Transform")
    // Roots carry their leading "/": indentation alone was misread by a real model, which took an
    // empty root ("CarGroup") for the parent of the root below it and addressed three children
    // wrongly. The slash also shows the path syntax the tools want, at no extra line.
    const name = depth === 0 ? `/${node.name}` : node.name
    lines.push(`${"  ".repeat(depth)}${name}${node.activeSelf === false ? " (inactive)" : ""}${components.length > 0 ? `  [${components.join(", ")}]` : ""}`)
    renderTree(node.children ?? [], depth + 1, lines)
  }
}

function findNode(nodes: HierarchyNode[], path: string): HierarchyNode | null {
  for (const node of nodes) {
    if (node.hierarchyPath === path) return node
    const nested = findNode(node.children ?? [], path)
    if (nested) return nested
  }
  return null
}

const sceneTitle = (h: Hierarchy) => `${h.scenePath || "(untitled scene, never saved)"}${h.isDirty ? "  *unsaved changes*" : ""}`

function renderValue(value: unknown): string {
  if (isHandle(value)) {
    const handle = value as { hierarchyPath?: string; assetPath?: string; type?: string }
    return `-> ${handle.assetPath ?? handle.hierarchyPath ?? "?"} (${handle.type ?? "Object"})`
  }
  if (Array.isArray(value)) return `[${value.map(renderValue).join(", ")}]`
  // Serialized floats carry single-precision noise (0.30000001192092896)
  if (typeof value === "number") return String(Number(value.toFixed(4)))
  return JSON.stringify(value)
}

export type TagsLayers = { tags: string[]; layers: string[] }

/** Tags and layers defined in the project, or null when the Editor would not say. */
export async function fetchTagsLayers(call: PipelineCall): Promise<TagsLayers | null> {
  const response = await call("get_tags_layers")
  if (!response.ok) return null
  return (response.result as { values?: TagsLayers }).values ?? null
}

/**
 * The model cannot create a tag or a layer (ProjectSettings/ is guarded), so every look at the
 * scene carries the list it is allowed to choose from. Without it, the only way it learns is by
 * sending a name that does not exist, which leaves an error in the user's Console.
 */
function renderTagsLayers(values: TagsLayers | null): string[] {
  const lines: string[] = []
  if (values?.tags?.length) lines.push(`Tags: ${values.tags.join(", ")}`)
  if (values?.layers?.length) lines.push(`Layers: ${values.layers.join(", ")}`)
  if (lines.length === 0) return []
  return ["", ...lines, "Only these exist. The user adds new ones in Project Settings > Tags and Layers."]
}

/**
 * The editing tool to point at depends on which ones the mode registered: unity_scene_edit is
 * deleted in the default "simple" mode, so naming it there sends the model at a tool it cannot see.
 */
function nextStep(target: string, flatTools: boolean, example: { component: string; assignment: string } | null): string {
  if (!flatTools) return `→ change values with unity_scene_edit: {"op":"set","target":"${target}","component":"<Component>","values":{...}}`
  if (!example) return "→ change a value with unity_component_set, or add behaviour with unity_component_add."
  return `→ change a value with unity_component_set: path "${target}", component "${example.component}", values "${example.assignment}"`
}

/** `flatTools`: unity_component_set and friends are registered (every mode but "batch"). */
export async function viewScene(call: PipelineCall, path?: string, options: { flatTools?: boolean } = {}): Promise<string> {
  const flatTools = options.flatTools ?? true
  const response = await call("get_scene_hierarchy")
  if (!response.ok) return `[unity] The scene could not be read: ${response.error}`
  const hierarchy = response.result as Hierarchy

  if (!path) {
    const lines: string[] = []
    renderTree(hierarchy.roots, 0, lines)
    if (lines.length >= MAX_TREE_LINES) lines.push(`... (truncated at ${MAX_TREE_LINES} objects)`)
    const tagsLayers = renderTagsLayers(await fetchTagsLayers(call))
    return [`Scene: ${sceneTitle(hierarchy)}`, "", ...lines, ...tagsLayers, "", '→ unity_scene_view("/Object/Path") shows the components and values of one object.'].join("\n")
  }

  const wanted = normalizePath(path)
  const node = findNode(hierarchy.roots, wanted)
  if (!node) {
    const close = suggest(wanted, flatten(hierarchy.roots).keys())
    return `No object at '${wanted}'.${close.length > 0 ? ` Closest: ${close.join(", ")}` : ""}\n\n→ unity_scene_view() lists the whole scene.`
  }

  // One round trip for all components: every CLI call costs a process start.
  const batch = await call("batch", {
    transactional: false,
    on_error: "continue",
    operations: node.components.map((type) => ({ command: "get_component_properties", params: { target: node.hierarchyPath, type } })),
  })
  const results = batch.ok ? (batch.result as BatchResult).results : []

  const lines = [`${node.hierarchyPath}${node.activeSelf === false ? " (inactive)" : ""}`, `children: ${(node.children ?? []).map((c) => c.name).join(", ") || "none"}`]
  // A next step built from a value that is actually on screen beats a <placeholder> the model
  // has to fill in: it is a call it can copy, with names it has just read.
  let example: { component: string; assignment: string } | null = null
  node.components.forEach((component, i) => {
    lines.push("", `${component}:`)
    const result = results[i]
    if (!result?.success) return lines.push(`  (not readable${result?.error ? `: ${result.error}` : ""})`)
    const properties = (result.result as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
    for (const [name, value] of Object.entries(properties)) {
      if (typeof value === "string" && value.startsWith("<unsupported")) continue
      lines.push(`  ${friendlyName(name)} = ${renderValue(value)}`)
      if (!example && (typeof value === "number" || typeof value === "boolean")) example = { component, assignment: `${friendlyName(name)}=${renderValue(value)}` }
    }
  })
  // No tags/layers here on purpose: a real session called this view 28 times against 4 whole-scene
  // views, and three extra lines each time is context a small model needs for the task.
  lines.push("", nextStep(node.hierarchyPath, flatTools, example))
  return lines.join("\n")
}

// ---------------------------------------------------------------- edit

type Planner = {
  graph: SymbolGraph | null
  /** Names of MonoBehaviour scripts in the project (class = file name) */
  scripts: Set<string>
  call: PipelineCall
  /** Whether a project-relative asset path ("Assets/...") exists; omitted = not checked */
  assetExists?: (assetPath: string) => boolean
  /** Text of a project-relative asset, to spot hand-written YAML that Unity cannot import */
  readAsset?: (assetPath: string) => string | null
}

const propertyCache = new Map<string, Record<string, unknown>>()

/**
 * Serialized properties of a component type that is not in the scene yet: read them off a
 * throwaway object created and deleted within one batch. (Letting the batch fail on purpose
 * would also revert it, but Unity logs the failure as an error in the user's Console.)
 */
async function probeProperties(call: PipelineCall, type: string): Promise<Record<string, unknown> | string> {
  const cached = propertyCache.get(type)
  if (cached) return cached
  const response = await call("batch", {
    operations: [
      { id: "probe", command: "create_gameobject", params: { name: "__opencode_unity_probe" } },
      { command: "add_component", params: { target: "$probe.instanceId", type } },
      { command: "get_component_properties", params: { target: "$probe.instanceId", type } },
      { command: "delete_gameobject", params: { target: "$probe.instanceId" } },
    ],
  })
  if (!response.ok) return response.error
  const batch = response.result as BatchResult
  const props = batch.results.find((r) => r.command === "get_component_properties")
  if (!props?.success) return batch.results.find((r) => !r.success && !r.skipped)?.error ?? "unknown error"
  const properties = (props.result as { properties: Record<string, unknown> }).properties
  propertyCache.set(type, properties)
  return properties
}

function checkComponentType(type: string, planner: Planner): string | null {
  if (planner.scripts.has(type)) return null
  const simple = type.slice(type.lastIndexOf(".") + 1)
  if (planner.scripts.has(simple)) return null
  if (!planner.graph) return null // cannot check: let Unity decide

  const types = planner.graph.findTypes(type).filter((t) => t.kind === "class")
  const component = types.find((t) => t.simple === simple && planner.graph!.baseChain(t).some((b) => b.lookup === "UnityEngine.Component"))
  if (component) return null
  if (types.some((t) => t.simple === simple)) return `'${type}' exists but is not a Component: it cannot be added to a GameObject.`

  const names = [...planner.graph.typeNames(), ...planner.scripts]
  const close = suggest(simple, names, 4)
  return `There is no component named '${type}'.${close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : ""} If it is your own script, create the .cs file first and wait for the compile report to pass.`
}

export async function editScene(planner: Planner, request: EditRequest): Promise<string> {
  const { call } = planner
  const snapshot = await call("get_scene_hierarchy")
  if (!snapshot.ok) return `[unity] The scene could not be read: ${snapshot.error}`
  const hierarchy = snapshot.result as Hierarchy

  const objects = flatten(hierarchy.roots) // simulated state: path -> components
  const created = new Set<string>()
  const plan: { source: number; op: PipelineOp }[] = []
  const materials = new Map<string, number[]>() // asset path -> color, written before the batch
  const scales = new Map<string, number[]>() // scale of objects created or rescaled in this call
  const warnings: string[] = []

  /** Children of a non-uniformly scaled parent are stretched with it: a classic blocked-out-car mistake. */
  const warnIfStretched = async (parent: string, child: string) => {
    let scale = scales.get(parent)
    if (!scale && !created.has(parent)) {
      const transform = await call("get_component_properties", { target: parent, type: "Transform" })
      const value = transform.ok ? (transform.result as { properties?: Record<string, unknown> }).properties?.m_LocalScale : null
      if (isVector(value, 3)) scale = value
    }
    if (scale && Math.max(...scale) - Math.min(...scale) > 0.01) {
      warnings.push(`'${child}' is a child of '${parent}', whose scale is [${scale.join(", ")}]: the child is stretched by it and its own position and scale are relative to that. Usual fix: keep the parent an EMPTY object with scale [1,1,1] and put the scaled shape in a child (e.g. /Car empty, /Car/Body the scaled cube, /Car/Wheel_FL next to it).`)
    }
  }
  const errors: string[] = []
  const moved = new Map<string, string>() // object path before -> after, for the success message
  let tagsLayers: TagsLayers | null = null
  const loadTagsLayers = async () => (tagsLayers ??= await fetchTagsLayers(call))

  // One raw entry may expand into several operations: keep what the model actually sent for messages.
  const expanded = request.operations.flatMap((raw) => normalizeOps(raw).map((op) => ({ op, raw })))
  const operations = expanded.map((entry) => entry.op)
  for (const [index, op] of operations.entries()) {
    // With a single operation (the flat tools) the numbering is noise.
    const label = expanded.length > 1 ? `operation ${index + 1}${op.op ? ` (${op.op})` : ""}: ` : ""
    const fail = (message: string) => errors.push(`${label}${message.charAt(0).toUpperCase()}${message.slice(1)}`)
    const push = (command: string, params: Record<string, unknown>) => plan.push({ source: index, op: { command, params } })

    if (op.unknown) {
      fail(`unknown field${op.unknown.length === 1 ? "" : "s"} ${op.unknown.map((f) => `'${f}'`).join(", ")}. Allowed fields: op, ${FIELDS.join(", ")}.`)
    }

    const existing = (raw: string | undefined, what = "target"): string | null => {
      if (!raw) return fail(`'${what}' is required: the hierarchy path of an object, e.g. "/Player".`), null
      const path = normalizePath(raw)
      if (objects.has(path)) return path
      const close = suggest(path, objects.keys())
      return fail(`no object at '${path}'.${close.length > 0 ? ` Closest: ${close.join(", ")}.` : ""} Use unity_scene_view to see the scene.`), null
    }

    const common = async (path: string) => {
      for (const [field, length] of [["position", 3], ["rotation", 3], ["scale", 3]] as const) {
        if (op[field] !== undefined && !isVector(op[field], length)) fail(`'${field}' must be [x, y, z] numbers.`)
      }
      if (op.position || op.rotation || op.scale) {
        push("set_transform", { target: path, ...(op.position && { position: op.position }), ...(op.rotation && { rotation: op.rotation }), ...(op.scale && { scale: op.scale }) })
      }
      if (op.tag !== undefined) {
        const known = (await loadTagsLayers())?.tags
        if (known && !known.includes(op.tag)) fail(`tag '${op.tag}' does not exist. Existing tags: ${known.join(", ")}. New tags are added by the user in Project Settings > Tags and Layers.`)
        else push("set_tag", { target: path, tag: op.tag })
      }
      if (op.layer !== undefined) {
        const known = (await loadTagsLayers())?.layers
        if (known && !known.includes(op.layer)) fail(`layer '${op.layer}' does not exist. Existing layers: ${known.join(", ")}.`)
        else push("set_layer", { target: path, layer: op.layer })
      }
      if (op.active !== undefined) push("set_active", { target: path, active: op.active })
      if (op.color !== undefined) {
        const color = parseColor(op.color)
        if (!color) fail(`'color' must be a color name (red, black, gray...), a hex code like #808080, or three numbers from 0 to 1.`)
        else if (!objects.get(path)!.has("MeshRenderer")) fail(`'${path}' has no MeshRenderer, so it cannot show a color. Create it with a primitive (cube, sphere, plane...).`)
        else {
          // One material per object, named after it: a color on a shared material would repaint every user of it.
          const asset = `Assets/Materials/${path.slice(1).replace(/[^A-Za-z0-9_-]+/g, "_")}.mat`
          materials.set(asset, color)
          push("set_component_properties", { target: path, type: "MeshRenderer", properties: { m_Materials: [{ path: asset }] } })
        }
      }
    }

    const addComponent = (path: string, type: string) => {
      const problem = checkComponentType(type, planner)
      if (problem) return fail(problem)
      const simple = type.slice(type.lastIndexOf(".") + 1)
      // Unity refuses the duplicate anyway, and its refusal lands as an error in the user's Console.
      if (SINGLE_INSTANCE.has(simple) && objects.get(path)!.has(simple)) {
        return fail(`'${path}' already has a ${simple} and cannot have two. Set its values instead of adding it again, or remove it first.`)
      }
      push("add_component", { target: path, type })
      objects.get(path)!.add(simple)
    }

    const setValues = async (path: string, component: string, values: Record<string, unknown>) => {
      const simple = component.slice(component.lastIndexOf(".") + 1)
      if (!objects.get(path)!.has(simple)) {
        return fail(`'${path}' has no ${simple} component (it has: ${[...objects.get(path)!].join(", ")}). Add it first with add_component.`)
      }
      const isNew = created.has(path) || plan.some((p) => p.op.command === "add_component" && p.op.params.target === path && p.op.params.type === component)
      const source = isNew ? await probeProperties(call, component) : await call("get_component_properties", { target: path, type: component }).then((r) => (r.ok ? ((r.result as { properties: Record<string, unknown> }).properties ?? {}) : r.error))
      if (typeof source === "string") return fail(`the properties of ${simple} could not be read: ${source}`)

      const settable = Object.keys(source).filter((name) => !(typeof source[name] === "string" && (source[name] as string).startsWith("<unsupported")))
      const type = planner.graph?.findTypes(component).find((t) => t.simple === simple)
      const aliases = (name: string) =>
        type ? planner.graph!.membersOf(type).filter((m) => m.replacement?.toLowerCase().endsWith(name.toLowerCase())).map((m) => m.name) : []

      const properties: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(values)) {
        let resolved = resolveProperty(name, settable, aliases)
        let wrap = false
        if (!resolved) {
          // renderer.material in code is the first element of the serialized m_Materials array
          const plural = resolveProperty(`${name}s`, settable, aliases)
          if (plural && Array.isArray(source[plural])) (resolved = plural), (wrap = !Array.isArray(value))
        }
        if (!resolved) {
          const close = suggest(name, settable.map(friendlyName))
          fail(`${simple} has no settable property '${name}'.${close.length > 0 ? ` Closest: ${close.join(", ")}.` : ""} All: ${settable.map(friendlyName).join(", ")}.`)
          continue
        }
        const current = source[resolved]
        let converted: unknown
        try {
          // A list of numbers is one value (vector, color); any other list holds elements (materials).
          const elements = Array.isArray(current) && !(current.length > 0 && current.every((n) => typeof n === "number"))
          const unwrapped = unwrapTyped(value)
          converted = elements ? (wrap || !Array.isArray(unwrapped) ? [unwrapped] : unwrapped).map((item) => toValue(item, (current as unknown[])[0] ?? null)) : toValue(value, current)
        } catch (error) {
          fail(`${simple}.${name} ${(error as Error).message}.`)
          continue
        }
        for (const item of Array.isArray(converted) ? converted : [converted]) {
          const asset = isRecord(item) && typeof item.path === "string" ? item.path : null
          const corrupt = asset ? corruptAsset(planner.readAsset?.(asset) ?? null) : null
          if (asset && corrupt) fail(`asset '${asset}' exists but Unity cannot load it: ${corrupt}. It was probably written by hand. Do not reference it and do not try to repair it. For a plain color use "color" on create/modify (a new material is made for you), and tell the user to delete '${asset}'.`)
          else if (asset && planner.assetExists && !planner.assetExists(asset)) fail(`asset '${asset}' does not exist. Check the path (it starts with Assets/ and includes the extension), To give an object a plain color, use "color" on create/modify instead: a material is made for you.`)
        }
        properties[resolved] = converted
      }
      if (Object.keys(properties).length > 0) push("set_component_properties", { target: path, type: component, properties })
    }

    switch (op.op) {
      case "create": {
        if (!op.name) {
          fail("'name' is required.")
          break
        }
        const parent = op.parent ? existing(op.parent, "parent") : ""
        if (parent === null) break
        const path = `${parent}/${op.name}`
        if (objects.has(path)) {
          fail(`'${path}' already exists. Pick a unique name, or use op "modify" to change the existing object.`)
          break
        }
        const primitive = op.primitive?.toLowerCase()
        if (primitive && !PRIMITIVES.includes(primitive)) {
          fail(`primitive '${op.primitive}' does not exist. Use one of: ${PRIMITIVES.join(", ")}, or omit it for an empty object.`)
          break
        }
        push("create_gameobject", { name: op.name, ...(primitive && { primitive }), ...(parent && { parent }) })
        if (parent) await warnIfStretched(parent, path)
        if (isVector(op.scale, 3)) scales.set(path, op.scale)
        objects.set(path, new Set(["Transform", ...(primitive ? ["MeshFilter", "MeshRenderer", `${primitive === "plane" || primitive === "quad" ? "Mesh" : primitive[0]!.toUpperCase() + primitive.slice(1)}Collider`] : [])]))
        created.add(path)
        await common(path)
        for (const type of op.components ?? []) addComponent(path, type)
        break
      }
      case "modify": {
        const path = existing(op.target)
        if (!path) break
        await common(path)
        let current = path
        const rekey = (next: string) => {
          for (const key of [...objects.keys()]) {
            if (key !== current && !key.startsWith(`${current}/`)) continue
            objects.set(next + key.slice(current.length), objects.get(key)!)
            objects.delete(key)
          }
          current = next
        }
        if (op.parent !== undefined) {
          const parent = op.parent === "" || op.parent === "/" ? "" : existing(op.parent, "parent")
          if (parent !== null) {
            const moved = `${parent}/${current.slice(current.lastIndexOf("/") + 1)}`
            if (objects.has(moved)) fail(`'${moved}' already exists.`)
            else {
              push("set_parent", { target: current, ...(parent && { parent }) })
              rekey(moved)
            }
          }
        }
        if (op.name !== undefined) {
          const renamed = `${current.slice(0, current.lastIndexOf("/"))}/${op.name}`
          if (objects.has(renamed)) fail(`'${renamed}' already exists. Pick a unique name.`)
          else {
            push("rename_gameobject", { target: current, name: op.name })
            rekey(renamed)
          }
        }
        // Renaming or re-parenting changes the path of the object AND of every child. A model
        // that is only told "done" keeps addressing the old path: in a real session that cost
        // seven rejected calls in a row, and one move repeated because nothing confirmed it.
        if (current !== path) moved.set(path, current)
        break
      }
      case "add_component": {
        const path = existing(op.target)
        const type = op.type ?? op.component
        if (!path) break
        if (!type) {
          fail("'type' is required: the component class name, e.g. \"Rigidbody\".")
          break
        }
        addComponent(path, type)
        if (op.values && objects.get(path)!.has(type.slice(type.lastIndexOf(".") + 1))) await setValues(path, type, op.values)
        break
      }
      case "set": {
        const path = existing(op.target)
        const component = op.component ?? op.type
        if (!path) break
        if (!component || !op.values) {
          fail('\'component\' and \'values\' are required, e.g. { "op": "set", "target": "/Player", "component": "Rigidbody", "values": { "mass": 2 } }.')
          break
        }
        await setValues(path, component, op.values)
        break
      }
      case "remove_component": {
        const path = existing(op.target)
        const type = op.type ?? op.component
        if (!path || !type) {
          if (path) fail("'type' is required.")
          break
        }
        if (!objects.get(path)!.delete(type)) fail(`'${path}' has no ${type} component (it has: ${[...objects.get(path)!].join(", ")}).`)
        else push("remove_component", { target: path, type })
        break
      }
      case "delete": {
        const path = existing(op.target)
        if (!path) break
        push("delete_gameobject", { target: path })
        for (const key of [...objects.keys()]) if (key === path || key.startsWith(`${path}/`)) objects.delete(key)
        break
      }
      case "instantiate": {
        if (!op.prefab) {
          fail("'prefab' is required: the asset path of the prefab, e.g. \"Assets/Prefabs/Enemy.prefab\".")
          break
        }
        const name = op.name ?? op.prefab.slice(op.prefab.lastIndexOf("/") + 1).replace(/\.prefab$/i, "")
        const parent = op.parent ? existing(op.parent, "parent") : ""
        if (parent === null) break
        const path = `${parent}/${name}`
        if (objects.has(path) || objects.has(`/${name}`)) {
          fail(`an object named '${name}' already exists. Give the copy a unique 'name', for example ${name}_2.`)
          break
        }
        if (planner.assetExists && !planner.assetExists(op.prefab)) {
          fail(`prefab '${op.prefab}' does not exist. Create it first from a scene object with unity_prefab_create, or check the path (it starts with Assets/ and ends with .prefab).`)
          break
        }
        // The copy is created in the scene root, then moved: the package command has no parent argument.
        push("instantiate_prefab", { prefab: { path: op.prefab }, name })
        if (parent) push("set_parent", { target: `/${name}`, parent, world_position_stays: false })
        objects.set(path, new Set(["Transform"]))
        created.add(path)
        await common(path)
        break
      }
      default:
        fail(
          `${op.op ? `unknown op '${op.op}'` : "no 'op' given"}. You sent: ${JSON.stringify(expanded[index]!.raw).slice(0, 200)}. Every operation is ONE FLAT object whose "op" is a string, one of: ${OPS.join(", ")}. Correct shape: ${EXAMPLE}`,
        )
    }
  }

  if (errors.length > 0) {
    if (errors.length === 1 && expanded.length === 1) return `[unity] Scene NOT changed. ${errors[0]} Fix it and call the tool again.`
    return [`[unity] Scene NOT changed: ${errors.length} problem${errors.length === 1 ? "" : "s"} found before touching it. Fix ${errors.length === 1 ? "it" : "them"} and call the tool again.`, "", ...errors.map((e, i) => `${i + 1}) ${e}`)].join("\n")
  }
  if (plan.length === 0) return "[unity] Nothing to do: no operations given."
  if (request.dryRun) return `[unity] Valid, but NOTHING WAS APPLIED because dry_run was true. Call unity_scene_edit again with the same operations and without dry_run to apply them.`

  // Asset writes are outside Unity's Undo, so they cannot be part of the transactional batch.
  for (const [asset, color] of materials) {
    if (!planner.assetExists?.(asset)) {
      const created = await call("create_asset", { path: asset, type: "UnityEngine.Material" })
      if (!created.ok) return `[unity] Scene NOT changed: the material ${asset} could not be created: ${created.error}`
    }
    // URP/HDRP Lit call it _BaseColor, the built-in Standard shader _Color: unknown names are ignored.
    const painted = await call("set_material_properties", { material: { path: asset }, properties: { _BaseColor: color, _Color: color } })
    if (!painted.ok) return `[unity] Scene NOT changed: the color of ${asset} could not be set: ${painted.error}`
  }

  const response = await call("batch", { operations: plan.map((p) => p.op) })
  if (!response.ok) return `[unity] Scene NOT changed: ${response.error}`
  const batch = response.result as BatchResult
  const failedAt = batch.results.findIndex((r) => !r.success && !r.skipped)
  if (failedAt >= 0) {
    const source = plan[failedAt]!.source
    const error = batch.results[failedAt]!.error ?? ""
    const missing = /No asset at path '([^']+)'/.exec(error)?.[1]
    const onDisk = missing && planner.assetExists?.(missing)
    // A script written moments ago is on disk, so our own check passes, but Unity only knows a
    // MonoBehaviour once it has compiled it. Seen in a real session: the model wrote WheelVisual.cs,
    // added it, got "Could not resolve component type", guessed the cause correctly and still gave up.
    const unresolved = /Could not resolve component type '([^']+)'/.exec(error)?.[1]
    const simple = unresolved?.slice(unresolved.lastIndexOf(".") + 1)
    const uncompiled = simple && planner.scripts.has(simple)
    const hint = onDisk
      ? ` The file is on disk but Unity could not import it, so it is corrupt or not an asset Unity understands. Do not retry with the same path. For a plain color use "color" on create/modify instead, and tell the user about '${missing}'.`
      : uncompiled
        ? ` ${simple}.cs is in the project but Unity has not compiled it yet. Call unity_compile, wait for it to pass, then add the component again.`
        : ""
    const which = operations.length > 1 ? `Operation ${source + 1} (${operations[source]!.op}) failed in Unity` : "Unity refused it"
    return `[unity] Scene NOT changed${operations.length > 1 ? " (everything was rolled back)" : ""}. ${which}: ${error}${hint}`
  }

  const lines = [
    operations.length === 1
      ? "[unity] Done. Scene changed (the user can undo it with Ctrl+Z)."
      : `[unity] Scene changed: ${operations.length} operations applied as one Undo step (the user can revert with Ctrl+Z).`,
  ]
  for (const [before, after] of moved) lines.push(`'${before}' is now '${after}'. Its children moved with it. Use the new path from now on.`)
  for (const warning of [...new Set(warnings)]) lines.push(`WARNING: ${warning}`)
  if (materials.size > 0) lines.push(`Materials written (not undoable): ${[...materials.keys()].join(", ")}.`)
  if (request.save) {
    if (!hierarchy.scenePath) {
      lines.push("The scene has never been saved, so it has no path: ask the user to save it once in the Editor (File > Save As).")
    } else {
      const saved = await call("save_scene")
      lines.push(saved.ok ? `Saved ${hierarchy.scenePath}.` : `Saving failed: ${saved.error}`)
    }
  } else {
    lines.push("The scene is not saved yet: call unity_scene_save when the user is happy with it.")
  }
  return lines.join("\n")
}

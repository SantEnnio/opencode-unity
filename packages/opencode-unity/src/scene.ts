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

/** [r,g,b], [r,g,b,a] (0-1, or 0-255 when any channel is above 1) or "#RRGGBB[AA]" -> [r,g,b,a] in 0-1. */
export function parseColor(value: unknown): number[] | null {
  if (typeof value === "string") {
    const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim())
    if (!hex) return null
    const channels = (hex[1]! + (hex[2] ?? "ff")).match(/../g)!
    return channels.map((c) => Number((parseInt(c, 16) / 255).toFixed(4)))
  }
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4) || !value.every((n) => typeof n === "number" && n >= 0)) return null
  const scale = value.some((n) => n > 1) ? 255 : 1
  const [r, g, b, a = scale] = value as number[]
  return [r!, g!, b!, a].map((n) => Number((n / scale).toFixed(4)))
}

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
function toValue(value: unknown, current: unknown): unknown {
  const referenceField = current === null || isHandle(current)
  if (isRecord(value)) {
    if (typeof value.ref === "string") return { hierarchyPath: normalizePath(value.ref) }
    if (typeof value.asset === "string") return { path: value.asset }
    if (!referenceField || HANDLE_KEYS.some((key) => key in value)) return value
    const texts = Object.values(value).filter((v): v is string => typeof v === "string" && v.length > 0)
    if (texts.length === 1) return reference(texts[0]!)
    throw new Error(`is an object reference: give it the hierarchy path of a scene object ("/Player") or an asset path ("Assets/Materials/Red.mat"), not ${JSON.stringify(value).slice(0, 120)}`)
  }
  return referenceField && typeof value === "string" && value.length > 0 ? reference(value) : value
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

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
    lines.push(`${"  ".repeat(depth)}${node.name}${node.activeSelf === false ? " (inactive)" : ""}${components.length > 0 ? `  [${components.join(", ")}]` : ""}`)
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

export async function viewScene(call: PipelineCall, path?: string): Promise<string> {
  const response = await call("get_scene_hierarchy")
  if (!response.ok) return `[unity] The scene could not be read: ${response.error}`
  const hierarchy = response.result as Hierarchy

  if (!path) {
    const lines: string[] = []
    renderTree(hierarchy.roots, 0, lines)
    if (lines.length >= MAX_TREE_LINES) lines.push(`... (truncated at ${MAX_TREE_LINES} objects)`)
    return [`Scene: ${sceneTitle(hierarchy)}`, "", ...lines, "", '→ unity_scene_view("/Object/Path") shows the components and values of one object.'].join("\n")
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
  node.components.forEach((component, i) => {
    lines.push("", `${component}:`)
    const result = results[i]
    if (!result?.success) return lines.push(`  (not readable${result?.error ? `: ${result.error}` : ""})`)
    const properties = (result.result as { properties?: Record<string, unknown> }).properties ?? {}
    for (const [name, value] of Object.entries(properties)) {
      if (typeof value === "string" && value.startsWith("<unsupported")) continue
      lines.push(`  ${friendlyName(name)} = ${renderValue(value)}`)
    }
  })
  lines.push("", `→ change values with unity_scene_edit: {"op":"set","target":"${node.hierarchyPath}","component":"<Component>","values":{...}}`)
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
  let tagsLayers: { tags: string[]; layers: string[] } | null = null

  const loadTagsLayers = async () => {
    if (tagsLayers) return tagsLayers
    const response = await call("get_tags_layers")
    tagsLayers = response.ok ? ((response.result as { values?: { tags: string[]; layers: string[] } }).values ?? null) : null
    return tagsLayers
  }

  // One raw entry may expand into several operations: keep what the model actually sent for messages.
  const expanded = request.operations.flatMap((raw) => normalizeOps(raw).map((op) => ({ op, raw })))
  const operations = expanded.map((entry) => entry.op)
  for (const [index, op] of operations.entries()) {
    const label = `operation ${index + 1}${op.op ? ` (${op.op})` : ""}`
    const fail = (message: string) => errors.push(`${label}: ${message}`)
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
        if (!color) fail(`'color' must be [r, g, b] with values from 0 to 1, or a hex string like "#808080".`)
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
      push("add_component", { target: path, type })
      objects.get(path)!.add(type.slice(type.lastIndexOf(".") + 1))
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
          converted = Array.isArray(current) ? (wrap || !Array.isArray(value) ? [value] : value).map((item) => toValue(item, current[0] ?? null)) : toValue(value, current)
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
        const path = `/${name}`
        if (objects.has(path)) {
          fail(`'${path}' already exists. Give the instance a unique 'name'.`)
          break
        }
        push("instantiate_prefab", { prefab: { path: op.prefab }, name })
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
    return [`[unity] Scene NOT changed: ${errors.length} problem${errors.length === 1 ? "" : "s"} found before touching it. Fix and call unity_scene_edit again.`, "", ...errors.map((e, i) => `${i + 1}) ${e}`)].join("\n")
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
    const hint = onDisk ? ` The file is on disk but Unity could not import it, so it is corrupt or not an asset Unity understands. Do not retry with the same path. For a plain color use "color" on create/modify instead, and tell the user about '${missing}'.` : ""
    return `[unity] Scene NOT changed (everything was rolled back). Operation ${source + 1} (${operations[source]!.op}) failed in Unity: ${error}${hint}`
  }

  const lines = [`[unity] Scene changed: ${operations.length} operation${request.operations.length === 1 ? "" : "s"} applied as one Undo step (the user can revert with Ctrl+Z).`]
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
    lines.push("The scene is NOT saved yet. Pass save: true when the user is happy with it, or let them save in the Editor.")
  }
  return lines.join("\n")
}

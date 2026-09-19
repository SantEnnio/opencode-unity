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
}

export type HierarchyNode = { name: string; hierarchyPath: string; activeSelf?: boolean; components: string[]; children: HierarchyNode[] }
export type Hierarchy = { sceneName: string; scenePath: string; isDirty: boolean; roots: HierarchyNode[] }
export type PipelineOp = { command: string; params: Record<string, unknown> }

/** Transport to the Editor. `null` result + error text on failure. */
export type PipelineCall = (command: string, params?: Record<string, unknown>) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>

export type EditRequest = { operations: SceneOp[]; save?: boolean; dryRun?: boolean }

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

const isVector = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && value.every((n) => typeof n === "number") && (length === undefined || value.length === length)

const isHandle = (value: unknown) => typeof value === "object" && value !== null && "instanceId" in value

/** Object-reference fields take a handle; the model may pass "/Path", "Assets/x.mat", {ref} or {asset}. */
function toValue(value: unknown, current: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    if (typeof v.ref === "string") return { hierarchyPath: normalizePath(v.ref) }
    if (typeof v.asset === "string") return { path: v.asset }
    return value
  }
  const referenceField = current === null || isHandle(current)
  if (referenceField && typeof value === "string" && value.length > 0) {
    return /^(Assets|Packages)\//.test(value) ? { path: value } : { hierarchyPath: normalizePath(value) }
  }
  return value
}

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
  const errors: string[] = []
  let tagsLayers: { tags: string[]; layers: string[] } | null = null

  const loadTagsLayers = async () => {
    if (tagsLayers) return tagsLayers
    const response = await call("get_tags_layers")
    tagsLayers = response.ok ? ((response.result as { values?: { tags: string[]; layers: string[] } }).values ?? null) : null
    return tagsLayers
  }

  for (const [index, op] of request.operations.entries()) {
    const label = `operation ${index + 1} (${op.op})`
    const fail = (message: string) => errors.push(`${label}: ${message}`)
    const push = (command: string, params: Record<string, unknown>) => plan.push({ source: index, op: { command, params } })

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
        const resolved = resolveProperty(name, settable, aliases)
        if (!resolved) {
          const close = suggest(name, settable.map(friendlyName))
          fail(`${simple} has no settable property '${name}'.${close.length > 0 ? ` Closest: ${close.join(", ")}.` : ""} All: ${settable.map(friendlyName).join(", ")}.`)
          continue
        }
        properties[resolved] = toValue(value, source[resolved])
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
        fail(`unknown op '${op.op}'. Use one of: ${OPS.join(", ")}.`)
    }
  }

  if (errors.length > 0) {
    return [`[unity] Scene NOT changed: ${errors.length} problem${errors.length === 1 ? "" : "s"} found before touching it. Fix and call unity_scene_edit again.`, "", ...errors.map((e, i) => `${i + 1}) ${e}`)].join("\n")
  }
  if (plan.length === 0) return "[unity] Nothing to do: no operations given."
  if (request.dryRun) return `[unity] Valid: ${request.operations.length} operation${request.operations.length === 1 ? "" : "s"} would be applied. Scene not changed (dry run).`

  const response = await call("batch", { operations: plan.map((p) => p.op) })
  if (!response.ok) return `[unity] Scene NOT changed: ${response.error}`
  const batch = response.result as BatchResult
  const failedAt = batch.results.findIndex((r) => !r.success && !r.skipped)
  if (failedAt >= 0) {
    const source = plan[failedAt]!.source
    return `[unity] Scene NOT changed (everything was rolled back). Operation ${source + 1} (${request.operations[source]!.op}) failed in Unity: ${batch.results[failedAt]!.error}`
  }

  const lines = [`[unity] Scene changed: ${request.operations.length} operation${request.operations.length === 1 ? "" : "s"} applied as one Undo step (the user can revert with Ctrl+Z).`]
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

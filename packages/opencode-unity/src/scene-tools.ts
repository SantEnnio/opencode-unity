// Scene tools for small models: one action per tool, flat arguments, plain text for anything
// structured. A real qwen3.6-35b-a3b session wrote correct JSON into a file and then broke the
// very same JSON, at the same spot, every time it had to go inside a tool argument. So the model
// is never asked for nested JSON here: a vector is "0, 1, 0", values are "mass=1500; useGravity=true".
// Every tool funnels into editScene, which keeps validation, the transaction and the Undo step.

import { arg, defineTool, optional, type ToolSpec } from "./args.ts"
import { editScene, type PipelineCall, type SceneOp } from "./scene.ts"
import type { SymbolGraph } from "./graph/db.ts"

export type SceneToolDeps = {
  /** null when no Editor with the Pipeline package is connected for the session's project */
  connect(directory: string, signal: AbortSignal): Promise<{
    call: PipelineCall
    graph: SymbolGraph | null
    scripts: Set<string>
    assetExists(asset: string): boolean
    readAsset(asset: string): string | null
  } | null>
  notConnected: string
  /** Escalates when the same failing call is repeated */
  breakLoop(sessionID: string, toolName: string, input: unknown, output: string, failed: boolean): string
  /** Set when an identical call already failed twice: answer without executing again */
  stuck(sessionID: string, toolName: string, input: unknown): string | null
}

/** "0, 1, 0", "0 1 0", "(0,1,0)", "[0, 1, 0]", "x=0 y=1 z=0" -> [0, 1, 0]. Returns a message when it is not a vector. */
export function parseVector(text: string | undefined, name: string, length = 3): number[] | string | undefined {
  if (text === undefined || text.trim() === "") return undefined
  const numbers = text.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? []
  if (numbers.length === 1 && name === "scale") return [numbers[0]!, numbers[0]!, numbers[0]!]
  if (numbers.length !== length || numbers.some((n) => !Number.isFinite(n))) return `'${name}' must be ${length} numbers separated by commas, for example "0, 1.5, -3". You wrote "${text}".`
  return numbers
}

function parseScalar(text: string): unknown {
  const value = text.trim().replace(/^["'](.*)["']$/s, "$1")
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true"
  if (/^-?\d*\.?\d+(?:e-?\d+)?f?$/i.test(value)) return Number(value.replace(/f$/i, ""))
  if (/^[([]?\s*-?\d*\.?\d+(\s*[, ]\s*-?\d*\.?\d+)+\s*[)\]]?$/.test(value)) return value.match(/-?\d*\.?\d+/g)!.map(Number)
  if (/^null|none$/i.test(value)) return null
  return value
}

/** "mass=1500; useGravity=true; offset=0,3,-6; target=/Car" -> { mass: 1500, useGravity: true, offset: [0,3,-6], target: "/Car" } */
export function parseValues(text: string): Record<string, unknown> | string {
  const values: Record<string, unknown> = {}
  // Pairs are separated by ";" or new lines. A comma only separates pairs when what follows is "name=".
  const pairs = text
    .replace(/^[{\s]+|[}\s]+$/g, "")
    .split(/[;\n]|,(?=\s*"?[A-Za-z_]\w*"?\s*[=:](?!\/))/)
    .map((pair) => pair.trim())
    .filter(Boolean)
  for (const pair of pairs) {
    const match = /^"?([A-Za-z_][\w.]*)"?\s*[=:]\s*(.+)$/s.exec(pair)
    if (!match) return `Could not read "${pair}". Write each value as name=value and separate them with ";", for example "mass=1500; useGravity=true".`
    values[match[1]!] = parseScalar(match[2]!)
  }
  return Object.keys(values).length > 0 ? values : 'No values given. Write them as name=value separated by ";", for example "mass=1500; useGravity=true".'
}

const splitList = (text: string | undefined) => (text ?? "").split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean)

const VECTOR = "Three numbers separated by commas, for example 0, 1.5, -3"

export function sceneTools(deps: SceneToolDeps): Record<string, ToolSpec<any>> {
  /** Runs one operation through the shared engine, with loop protection. */
  async function run(toolName: string, args: Record<string, unknown>, context: { directory: string; sessionID: string; abort: AbortSignal }, build: () => SceneOp | string, next = ""): Promise<string> {
    const stuck = deps.stuck(context.sessionID, toolName, args)
    if (stuck) return stuck
    const op = build()
    if (typeof op === "string") return deps.breakLoop(context.sessionID, toolName, args, `[unity] Scene NOT changed: ${op}`, true)

    const editor = await deps.connect(context.directory, context.abort)
    if (!editor) return deps.notConnected
    const output = await editScene(editor, { operations: [op] })
    const failed = output.includes("NOT changed")
    // A small model follows an explicit pointer far better than it plans the next step itself.
    return deps.breakLoop(context.sessionID, toolName, args, failed || !next ? output : `${output}\n→ Next: ${next}`, failed)
  }

  const vectors = (args: { position?: string; rotation?: string; scale?: string }): Partial<SceneOp> | string => {
    const out: Partial<SceneOp> = {}
    for (const name of ["position", "rotation", "scale"] as const) {
      const parsed = parseVector(args[name], name)
      if (typeof parsed === "string") return parsed
      if (parsed) out[name] = parsed
    }
    return out
  }

  return {
    unity_object_create: defineTool({
      description:
        'Create one object in the open Unity scene. Give it a shape to make it visible, or no shape for an empty group. To build something made of parts (a car, a house), first create an empty group, then create each part with the group as its parent. Example arguments: name "Wheel_FL", shape "cylinder", parent "/Car", position "-0.6, -0.25, 0.8", scale "0.5, 0.1, 0.5", color "black".',
      args: {
        name: arg.string("Name of the new object. Must be unique under its parent"),
        shape: optional(arg.enum(["empty", "cube", "sphere", "capsule", "cylinder", "plane", "quad"], "Visible shape. Leave out or use empty for a group")),
        parent: optional(arg.string("Hierarchy path of the parent object, for example /Car. Leave out for the scene root")),
        position: optional(arg.string(`Local position. ${VECTOR}`)),
        rotation: optional(arg.string("Rotation in degrees. Three numbers separated by commas, for example 0, 90, 0")),
        scale: optional(arg.string("Size. Three numbers separated by commas, for example 2, 1, 2. One number scales all axes")),
        color: optional(arg.string("Color name such as red, or a hex code such as #E53935. Only for objects with a shape")),
        components: optional(arg.string("Component class names to add, separated by commas, for example Rigidbody, BoxCollider")),
      },
      execute: (args, context) =>
        run("unity_object_create", args, context, () => {
          const v = vectors(args)
          if (typeof v === "string") return v
          const components = splitList(args.components)
          return { op: "create", name: args.name, ...(args.shape && args.shape !== "empty" && { primitive: args.shape }), ...(args.parent && { parent: args.parent }), ...v, ...(args.color && { color: args.color }), ...(components.length > 0 && { components }) }
        }, !args.shape || args.shape === "empty"
          ? `create its parts with unity_object_create and parent "${args.parent ? `${args.parent.replace(/\/+$/, "")}/` : "/"}${args.name}".`
          : "create the next object, or add behaviour with unity_component_add. After a few objects, check the result with unity_scene_view."),
    }),

    unity_object_modify: defineTool({
      description:
        'Change one existing object in the open Unity scene: move, rotate, resize, recolor, tag, layer, show or hide, rename, or move under another parent. Only give the arguments you want to change. Example arguments: path "/Car", position "0, 2, 0", rotation "0, 90, 0".',
      args: {
        path: arg.string("Hierarchy path of the object, for example /Car/Body"),
        position: optional(arg.string(`New local position. ${VECTOR}`)),
        rotation: optional(arg.string("New rotation in degrees. Three numbers separated by commas")),
        scale: optional(arg.string("New size. Three numbers separated by commas")),
        color: optional(arg.string("Color name such as red, or a hex code such as #E53935")),
        tag: optional(arg.string("One of the tags unity_scene_view lists, for example Player. A tag that does not exist yet cannot be used")),
        layer: optional(arg.string("One of the layers unity_scene_view lists, for example Default. A layer that does not exist yet cannot be used")),
        active: optional(arg.boolean("false hides the object, true shows it")),
        new_name: optional(arg.string("Rename the object")),
        new_parent: optional(arg.string("Hierarchy path of the new parent. Use / for the scene root")),
      },
      execute: (args, context) =>
        run("unity_object_modify", args, context, () => {
          const v = vectors(args)
          if (typeof v === "string") return v
          return {
            op: "modify",
            target: args.path,
            ...v,
            ...(args.color && { color: args.color }),
            ...(args.tag && { tag: args.tag }),
            ...(args.layer && { layer: args.layer }),
            ...(args.active !== undefined && { active: args.active }),
            ...(args.new_name && { name: args.new_name }),
            ...(args.new_parent !== undefined && { parent: args.new_parent === "/" ? "" : args.new_parent }),
          }
        }),
    }),

    unity_object_delete: defineTool({
      description: 'Delete one object, and everything inside it, from the open Unity scene. The user can undo it with Ctrl+Z. Example arguments: path "/Old".',
      args: { path: arg.string("Hierarchy path of the object to delete, for example /Old") },
      execute: (args, context) => run("unity_object_delete", args, context, () => ({ op: "delete", target: args.path })),
    }),

    unity_component_add: defineTool({
      description:
        'Add one component to an object in the open Unity scene, optionally setting values at the same time. Your own scripts work too, after their .cs file exists and the compile report passed. Example arguments: path "/Car", component "Rigidbody", values "mass=1500; useGravity=true".',
      args: {
        path: arg.string("Hierarchy path of the object, for example /Car"),
        component: arg.string("Component class name, for example Rigidbody or CarController"),
        values: optional(arg.string('Optional values as name=value separated by ";", for example mass=1500; useGravity=true')),
      },
      execute: (args, context) =>
        run("unity_component_add", args, context, () => {
          const values = args.values?.trim() ? parseValues(args.values) : undefined
          if (typeof values === "string") return values
          return { op: "add_component", target: args.path, type: args.component, ...(values && { values }) }
        }, `unity_scene_view with path "${args.path}" shows the names and current values of ${args.component}, which unity_component_set can change.`),
    }),

    unity_component_set: defineTool({
      description:
        'Set values on a component that an object already has, like typing them in the Inspector. Write the values as name=value separated by ";". A number is written 1500. A switch is true or false. A vector is 0, 3, -6. A reference to another object is its path such as /Car. A reference to an asset is its path such as Assets/Materials/Red.mat. Look at the current names and values first with unity_scene_view. Example arguments: path "/Main Camera", component "CameraFollow", values "target=/Car; offset=0, 3, -6; smooth=5".',
      args: {
        path: arg.string("Hierarchy path of the object, for example /Car"),
        component: arg.string("Component class name, for example Rigidbody"),
        values: arg.string('Values as name=value separated by ";", for example mass=1500; useGravity=true; offset=0, 3, -6; target=/Car'),
      },
      execute: (args, context) =>
        run("unity_component_set", args, context, () => {
          const values = parseValues(args.values)
          return typeof values === "string" ? values : { op: "set", target: args.path, component: args.component, values }
        }),
    }),

    unity_component_remove: defineTool({
      description: 'Remove one component from an object in the open Unity scene. Example arguments: path "/Car", component "BoxCollider".',
      args: {
        path: arg.string("Hierarchy path of the object, for example /Car"),
        component: arg.string("Component class name, for example BoxCollider"),
      },
      execute: (args, context) => run("unity_component_remove", args, context, () => ({ op: "remove_component", target: args.path, type: args.component })),
    }),

    unity_prefab_place: defineTool({
      description: 'Place a copy of a prefab in the open Unity scene. Example arguments: prefab "Assets/Prefabs/Enemy.prefab", name "Enemy1", position "3, 0, 0".',
      args: {
        prefab: arg.string("Asset path of the prefab, for example Assets/Prefabs/Enemy.prefab"),
        name: optional(arg.string("Name for the copy. Must be unique where it is placed")),
        parent: optional(arg.string("Hierarchy path of the parent object, for example /Obstacles. Leave out for the scene root")),
        position: optional(arg.string(`Position. ${VECTOR}`)),
        rotation: optional(arg.string("Rotation in degrees. Three numbers separated by commas")),
      },
      execute: (args, context) =>
        run("unity_prefab_place", args, context, () => {
          const v = vectors(args)
          return typeof v === "string" ? v : { op: "instantiate", prefab: args.prefab, ...(args.name && { name: args.name }), ...(args.parent && { parent: args.parent }), ...v }
        }),
    }),

    unity_prefab_create: defineTool({
      description:
        'Save an object of the open Unity scene, with everything inside it, as a reusable prefab asset. Build the thing once (for example one wheel, one obstacle, one enemy), make it a prefab, then place as many copies as needed with unity_prefab_place. The object in the scene stays and becomes linked to the prefab. Example arguments: path "/Obstacle", prefab "Assets/Prefabs/Obstacle.prefab".',
      args: {
        path: arg.string("Hierarchy path of the object to save as a prefab, for example /Obstacle"),
        prefab: optional(arg.string("Asset path for the prefab. Leave out to use Assets/Prefabs/ plus the object name")),
      },
      async execute(args, context) {
        const repeated = deps.stuck(context.sessionID, "unity_prefab_create", args)
        if (repeated) return repeated
        const editor = await deps.connect(context.directory, context.abort)
        if (!editor) return deps.notConnected
        const done = (output: string, failed: boolean) => deps.breakLoop(context.sessionID, "unity_prefab_create", args, output, failed)

        const source = `/${args.path.trim().replace(/^\/+|\/+$/g, "")}`
        const name = source.slice(source.lastIndexOf("/") + 1)
        let asset = (args.prefab?.trim() || `Assets/Prefabs/${name}.prefab`).replace(/\\/g, "/")
        if (!/^Assets\//.test(asset)) asset = `Assets/${asset.replace(/^\/+/, "")}`
        if (!/\.prefab$/i.test(asset)) asset += ".prefab"

        const found = await editor.call("find_gameobjects", { hierarchy_path: source })
        const count = found.ok ? ((found.result as { count?: number } | null)?.count ?? 0) : 0
        if (count === 0) return done(`[unity] Prefab NOT created: there is no object at '${source}'. Use unity_scene_view to see the scene.`, true)
        if (editor.assetExists(asset)) {
          return done(`[unity] Prefab NOT created: '${asset}' already exists. Place copies of it with unity_prefab_place, or choose another prefab name.`, true)
        }

        const created = await editor.call("create_prefab", { source, path: asset })
        if (!created.ok) return done(`[unity] Prefab NOT created: ${created.error}`, true)
        return done(`[unity] Prefab saved as ${asset} (an asset write: not undoable). '${source}' in the scene is now an instance of it.\n→ Place more copies with unity_prefab_place, prefab "${asset}", each with its own name and position.`, false)
      },
    }),

    unity_scene_save: defineTool({
      description: "Save the scene that is open in the Unity Editor. Do this when the user is happy with the changes, or before running tests.",
      args: {},
      async execute(_args, context) {
        const editor = await deps.connect(context.directory, context.abort)
        if (!editor) return deps.notConnected
        const saved = await editor.call("save_scene")
        return saved.ok ? "[unity] Scene saved." : `[unity] The scene could not be saved: ${saved.error}. If it has never been saved, ask the user to save it once in the Editor with File > Save As.`
      },
    }),
  }
}

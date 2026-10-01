import { describe, expect, test } from "bun:test"
import { unwrapTyped } from "../src/scene.ts"
import { corruptAsset, editScene, friendlyName, type Hierarchy, normalizeOp, normalizeOps, parseColor, type PipelineCall, resolveProperty, viewScene } from "../src/scene.ts"

const hierarchy: Hierarchy = {
  sceneName: "Main",
  scenePath: "Assets/Scenes/Main.unity",
  isDirty: false,
  roots: [
    { name: "Player", hierarchyPath: "/Player", components: ["Transform", "Rigidbody"], children: [{ name: "Gun", hierarchyPath: "/Player/Gun", components: ["Transform"], children: [] }] },
    { name: "Main Camera", hierarchyPath: "/Main Camera", components: ["Transform", "Camera"], children: [] },
  ],
}

const rigidbody = { m_Mass: 1, m_Drag: 0, m_UseGravity: true, m_InertiaRotation: "<unsupported:Quaternion>" }
const follower = { target: null, speed: 2, offset: [0, 0, 0] }

function fakeEditor(overrides: Record<string, (params: any) => unknown> = {}) {
  const calls: { command: string; params: any }[] = []
  const call: PipelineCall = async (command, params = {}) => {
    calls.push({ command, params })
    if (overrides[command]) return { ok: true, result: overrides[command]!(params) }
    switch (command) {
      case "get_scene_hierarchy":
        return { ok: true, result: hierarchy }
      case "get_tags_layers":
        return { ok: true, result: { values: { tags: ["Untagged", "Player"], layers: ["Default", "UI"] } } }
      case "get_component_properties":
        return { ok: true, result: { properties: params.type === "Rigidbody" ? rigidbody : follower } }
      case "batch": {
        const ops = params.operations as { command: string; params: any }[]
        // the throwaway-object probe for components that do not exist yet
        if (ops[0]?.params.name === "__opencode_unity_probe") {
          const type = ops[1]!.params.type
          return { ok: true, result: { applied: 4, results: [{ command: "create_gameobject", success: true }, { command: "add_component", success: true }, { command: "get_component_properties", success: true, result: { properties: type === "Rigidbody" ? rigidbody : follower } }, { command: "delete_gameobject", success: true }] } }
        }
        return { ok: true, result: { applied: ops.length, results: ops.map((o) => ({ command: o.command, success: true, ...(o.command === "get_component_properties" && { result: { properties: o.params.type === "Rigidbody" ? rigidbody : follower } }) })) } }
      }
      default:
        return { ok: true, result: {} }
    }
  }
  return { call, calls, applied: () => calls.filter((c) => c.command === "batch" && c.params.operations[0]?.params.name !== "__opencode_unity_probe").at(-1)?.params.operations as { command: string; params: any }[] | undefined }
}

const planner = (call: PipelineCall) => ({ graph: null, scripts: new Set(["Follower"]), call })

describe("scene helpers", () => {
  test("property names are matched the way a programmer writes them", () => {
    const available = Object.keys(rigidbody)
    expect(resolveProperty("mass", available)).toBe("m_Mass")
    expect(resolveProperty("UseGravity", available)).toBe("m_UseGravity")
    expect(resolveProperty("linearDamping", available, () => ["drag"])).toBe("m_Drag")
    expect(resolveProperty("weight", available)).toBeNull()
    expect(friendlyName("m_UseGravity")).toBe("useGravity")
    expect(friendlyName("speed")).toBe("speed")
  })
})

describe("unity_scene_view", () => {
  test("tree view", async () => {
    const out = await viewScene(fakeEditor().call)
    expect(out).toContain("Scene: Assets/Scenes/Main.unity")
    // Roots keep their slash, children do not: a model read two roots as parent and child.
    expect(out).toContain("/Player  [Rigidbody]\n  Gun")
    expect(out).toContain("/Main Camera")
  })

  test("unknown path suggests the closest object", async () => {
    expect(await viewScene(fakeEditor().call, "/Playr")).toContain("Closest: /Player")
  })

  // The model cannot create a tag or a layer, so the whole-scene view shows what it may pick.
  // The per-object view deliberately does not: it is called many times more often, and three
  // lines per call is context the task needs.
  test("the whole-scene view lists the tags and layers the project has", async () => {
    const out = await viewScene(fakeEditor().call)
    expect(out).toContain("Tags: Untagged, Player")
    expect(out).toContain("Layers: Default, UI")
    expect(out).toContain("Project Settings > Tags and Layers")

    const object = await viewScene(fakeEditor().call, "/Player")
    expect(object).not.toContain("Tags:")
  })

  // "simple" mode deletes unity_scene_edit, so naming it there points at a tool that is not registered.
  test("the next step names an editing tool the current mode registers", async () => {
    const flat = await viewScene(fakeEditor().call, "/Player")
    expect(flat).toContain('unity_component_set: path "/Player", component "Transform", values "speed=2"')
    expect(flat).not.toContain("unity_scene_edit")

    const batch = await viewScene(fakeEditor().call, "/Player", { flatTools: false })
    expect(batch).toContain('unity_scene_edit: {"op":"set","target":"/Player"')
    expect(batch).not.toContain("unity_component_set")
  })

  test("the scene is still shown when the Editor does not answer about tags and layers", async () => {
    const editor = fakeEditor()
    const call: PipelineCall = async (command, params) => (command === "get_tags_layers" ? { ok: false, error: "unknown command" } : editor.call(command, params))
    const out = await viewScene(call)
    expect(out).toContain("Scene: Assets/Scenes/Main.unity")
    expect(out).not.toContain("Tags:")
  })
})

// Both regressions come from one real session (2026-09-20): renaming /Car to PlayerCar and moving
// it under /CarGroup left the model addressing stale paths for seven calls in a row, and it then
// added a second Rigidbody to a wheel that already had one.
describe("paths and components after a move", () => {
  test("a rename or a re-parent reports where the object ended up", async () => {
    const editor = fakeEditor()
    const renamed = await editScene(planner(editor.call), { operations: [{ op: "modify", target: "/Player", name: "PlayerCar" }] })
    expect(renamed).toContain("'/Player' is now '/PlayerCar'. Its children moved with it.")

    const moved = await editScene(planner(fakeEditor().call), { operations: [{ op: "modify", target: "/Player", parent: "/Main Camera" }] })
    expect(moved).toContain("'/Player' is now '/Main Camera/Player'. Its children moved with it.")
  })

  // Real session: the model wrote WheelVisual.cs and added it in the next call. The file is on
  // disk so our own check passes, but Unity only knows a MonoBehaviour once it has compiled it.
  test("a script Unity has not compiled yet is answered with the fix, not the fault", async () => {
    const editor = fakeEditor({
      batch: (params: any) => ({
        applied: 0,
        results: (params.operations as any[]).map((o) => ({ command: o.command, success: false, error: "Could not resolve component type 'Follower'." })),
      }),
    })
    const out = await editScene(planner(editor.call), { operations: [{ op: "add_component", target: "/Player", type: "Follower" }] })
    expect(out).toContain("Follower.cs is in the project but Unity has not compiled it yet")
    expect(out).toContain("Call unity_compile")
  })

  test("a second Rigidbody is refused here instead of in Unity's Console", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), { operations: [{ op: "add_component", target: "/Player", type: "Rigidbody" }] })
    expect(out).toContain("already has a Rigidbody and cannot have two")
    expect(editor.applied()).toBeUndefined() // nothing was sent to Unity

    // A collider is not single-instance: several on one object are legitimate, so it still goes through.
    const collider = fakeEditor()
    await editScene(planner(collider.call), { operations: [{ op: "add_component", target: "/Player", type: "BoxCollider" }] })
    expect(collider.applied()?.map((o) => o.command)).toContain("add_component")
  })
})

describe("unity_scene_edit", () => {
  test("nothing is sent to Unity when any operation is wrong, and every problem is reported", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), {
      operations: [
        { op: "create", name: "Floor", primitive: "plain" },
        { op: "create", name: "Player" },
        { op: "modify", target: "/Player", tag: "Hero" },
        { op: "set", target: "/Player", component: "Rigidbody", values: { weight: 2 } },
        { op: "set", target: "/Main Camera", component: "Rigidbody", values: { mass: 2 } },
      ],
    })
    expect(out).toContain("Scene NOT changed: 5 problems")
    expect(out).toContain("Primitive 'plain' does not exist")
    expect(out).toContain("'/Player' already exists")
    expect(out).toContain("Tag 'Hero' does not exist. Existing tags: Untagged, Player")
    expect(out).toContain("no settable property 'weight'")
    expect(out).toContain("has no Rigidbody component")
    expect(editor.applied()).toBeUndefined()
  })

  test("a valid request becomes one batch addressed by hierarchy path", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), {
      operations: [
        { op: "create", name: "Enemy", primitive: "Cube", position: [1, 0, 0], tag: "Player", components: ["Follower"] },
        { op: "set", target: "/Enemy", component: "Follower", values: { target: "/Player", speed: 5 } },
        { op: "set", target: "/Player", component: "Rigidbody", values: { mass: 3, useGravity: false } },
        { op: "create", name: "Eye", parent: "/Enemy" },
        { op: "modify", target: "/Player/Gun", name: "Rifle" },
        { op: "delete", target: "/Main Camera" },
      ],
    })
    expect(out).toContain("6 operations applied as one Undo step")
    expect(out).toContain("not saved yet")
    expect(editor.applied()).toEqual([
      { command: "create_gameobject", params: { name: "Enemy", primitive: "cube" } },
      { command: "set_transform", params: { target: "/Enemy", position: [1, 0, 0] } },
      { command: "set_tag", params: { target: "/Enemy", tag: "Player" } },
      { command: "add_component", params: { target: "/Enemy", type: "Follower" } },
      { command: "set_component_properties", params: { target: "/Enemy", type: "Follower", properties: { target: { hierarchyPath: "/Player" }, speed: 5 } } },
      { command: "set_component_properties", params: { target: "/Player", type: "Rigidbody", properties: { m_Mass: 3, m_UseGravity: false } } },
      { command: "create_gameobject", params: { name: "Eye", parent: "/Enemy" } },
      { command: "rename_gameobject", params: { target: "/Player/Gun", name: "Rifle" } },
      { command: "delete_gameobject", params: { target: "/Main Camera" } },
    ])
  })

  // Seen live (2026-09-30): a field pointing at a component of its own object. Unity wants the
  // object's path; models write the component. Every one of these reached Unity and failed there.
  test.each(["/Player", "Player", "Rigidbody", "this", "self", "/Player/Rigidbody", "/Player.Rigidbody", "GetComponent<Rigidbody>()", "this.GetComponent<Rigidbody>()"])(
    "a reference to a component of the same object, written %s",
    async (written) => {
      const editor = fakeEditor()
      const out = await editScene(planner(editor.call), {
        operations: [
          { op: "add_component", target: "/Player", type: "Follower" },
          { op: "set", target: "/Player", component: "Follower", values: { target: written } },
        ],
      })
      expect(out).not.toContain("NOT changed")
      expect(editor.applied()!.at(-1)).toEqual({ command: "set_component_properties", params: { target: "/Player", type: "Follower", properties: { target: { hierarchyPath: "/Player" } } } })
    },
  )

  test("a reference to an object that does not exist is refused before Unity sees it", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), {
      operations: [
        { op: "add_component", target: "/Player/Gun", type: "Follower" },
        { op: "set", target: "/Player/Gun", component: "Follower", values: { target: "Camera" } },
      ],
    })
    expect(out).toContain("NOT changed")
    expect(out).toContain("target=/Player/Gun")
    expect(editor.applied()).toBeUndefined()
  })

  test("a failure inside Unity is mapped back to the model's own operation", async () => {
    const editor = fakeEditor({
      batch: (params) => ({ applied: 1, reverted: true, results: [{ command: "create_gameobject", success: true }, { command: "add_component", success: false, error: "Type 'Follower' is abstract" }] }),
    })
    const out = await editScene(planner(editor.call), { operations: [{ op: "create", name: "A" }, { op: "add_component", target: "/A", type: "Follower" }] })
    expect(out).toContain("rolled back")
    expect(out).toContain("Operation 2 (add_component) failed in Unity: Type 'Follower' is abstract")
  })

  test("warns when a child goes under a non-uniformly scaled parent", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), {
      operations: [
        { op: "create", name: "Car", primitive: "cube", scale: [1.2, 0.5, 2.2] },
        { op: "create", name: "Wheel", parent: "/Car", primitive: "cylinder" },
        { op: "create", name: "Rig" },
        { op: "create", name: "Cam", parent: "/Rig" },
      ],
    })
    expect(out).toContain("4 operations applied")
    expect(out).toContain("WARNING: '/Car/Wheel' is a child of '/Car', whose scale is [1.2, 0.5, 2.2]")
    expect(out).not.toContain("'/Rig/Cam' is a child")
  })

  test("dry run and save", async () => {
    const editor = fakeEditor()
    expect(await editScene(planner(editor.call), { operations: [{ op: "create", name: "A" }], dryRun: true })).toContain("NOTHING WAS APPLIED")
    expect(editor.applied()).toBeUndefined()
    expect(await editScene(planner(editor.call), { operations: [{ op: "create", name: "A" }], save: true })).toContain("Saved Assets/Scenes/Main.unity")
    expect(editor.calls.at(-1)?.command).toBe("save_scene")
  })
})

describe("color", () => {
  test("accepted forms", () => {
    expect(parseColor([1, 0.5, 0])).toEqual([1, 0.5, 0, 1])
    expect(parseColor([220, 30, 30])).toEqual([0.8627, 0.1176, 0.1176, 1])
    expect(parseColor("#404040")).toEqual([0.251, 0.251, 0.251, 1])
    expect(parseColor("grey")).toEqual([0.502, 0.502, 0.502, 1])
    expect(parseColor("Dark Gray")).toEqual(parseColor("#424242"))
    expect(parseColor("0.2, 0.4, 1")).toEqual([0.2, 0.4, 1, 1])
    expect(parseColor("plaid")).toBeNull()
    expect(parseColor([1, 2])).toBeNull()
  })

  test("a material is written first, then assigned inside the batch", async () => {
    const editor = fakeEditor()
    const out = await editScene({ ...planner(editor.call), assetExists: () => false }, { operations: [{ op: "create", name: "Car", primitive: "cube", color: "#ff0000" }] })
    expect(out).toContain("Materials written (not undoable): Assets/Materials/Car.mat")
    expect(editor.calls.map((c) => c.command)).toEqual(["get_scene_hierarchy", "create_asset", "set_material_properties", "batch"])
    expect(editor.calls[2]!.params).toEqual({ material: { path: "Assets/Materials/Car.mat" }, properties: { _BaseColor: [1, 0, 0, 1], _Color: [1, 0, 0, 1] } })
    expect(editor.applied()!.at(-1)).toEqual({ command: "set_component_properties", params: { target: "/Car", type: "MeshRenderer", properties: { m_Materials: [{ path: "Assets/Materials/Car.mat" }] } } })
  })

  test("needs a MeshRenderer, and nothing is written when validation fails", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), { operations: [{ op: "modify", target: "/Main Camera", color: [1, 1, 1] }] })
    expect(out).toContain("has no MeshRenderer")
    expect(editor.calls.some((c) => c.command === "create_asset")).toBe(false)
  })
})

// Shapes taken verbatim from a real qwen3.6-35b-a3b session, where all ten calls failed on nesting.
describe("operation shapes small models actually produce", () => {
  const ground = { name: "Ground", primitive: "plane", position: [0, -1, 0], scale: [200, 1, 200] }
  const flat = { op: "create", ...ground }

  test.each([
    ["flat", flat],
    ['{"op": {"create": {...}}}', { op: { create: ground } }],
    ['{"create": {...}}', { create: ground }],
    ['{"op": {...fields}}', { op: ground }],
    ["verb synonym", { action: "create_gameobject", ...ground }],
    ["vector as object", { op: "create", ...ground, position: { x: 0, y: -1, z: 0 } }],
  ])("%s", (_label, raw) => {
    expect(normalizeOp(raw)).toEqual(flat)
  })

  test('"set" carrying a transform is a modify; nested set keeps its component', () => {
    expect(normalizeOp({ op: { set: { target: "/Ground", scale: [200, 1, 200] } } })).toEqual({ op: "modify", target: "/Ground", scale: [200, 1, 200] })
    expect(normalizeOp({ op: { set: { target: "/Ring", component: "MeshRenderer", values: { material: "Assets/M.mat" } } } })).toEqual({
      op: "set",
      target: "/Ring",
      component: "MeshRenderer",
      values: { material: "Assets/M.mat" },
    })
  })

  test("seen live: a misspelled key wrapping the real fields is unwrapped, not dropped", () => {
    const raw = { op: "create", name: "Windows", parent: "/Car", "primitive:": { primitive: "cube", position: [0, 0.3, 0], scale: [0.9, 0.4, 1.2] } }
    expect(normalizeOp(raw)).toEqual({ op: "create", name: "Windows", parent: "/Car", primitive: "cube", position: [0, 0.3, 0], scale: [0.9, 0.4, 1.2] })
    expect(normalizeOp({ op: "create", name: "A", "Position:": [1, 2, 3] })).toEqual({ op: "create", name: "A", position: [1, 2, 3] })
  })

  test("seen live: degenerate output with junk keys still yields the operations it contains", () => {
    const raw = {
      op: "create",
      name: "Wheel_FL",
      parent: "/Car",
      "primitive:": { primitive: "capsule", position: [-0.6, -0.25, 0.8], scale: [0.5, 0.5, 0.5] },
      "op: ": { ": ": ", " },
      ": {": { op: "add_component", target: "/Car", type: "CarController" },
    }
    expect(normalizeOps(raw)).toEqual([
      { op: "create", name: "Wheel_FL", parent: "/Car", primitive: "capsule", position: [-0.6, -0.25, 0.8], scale: [0.5, 0.5, 0.5] },
      { op: "add_component", target: "/Car", type: "CarController" },
    ])
  })

  test("seen live: the same degeneration one session later, with the color buried in junk", async () => {
    const raw = {
      op: "create",
      name: "Wheel_FL",
      parent: "/Car",
      "primitive:": { primitive: "capsule", position: [-0.65, -0.25, 0.8], scale: [0.5, 0.5, 0.5] },
      "color:": { "#000000}}, {": ": {" },
    }
    expect(parseColor(raw["color:"])).toEqual([0, 0, 0, 1])
    const scene: Hierarchy = { ...hierarchy, roots: [{ name: "Car", hierarchyPath: "/Car", components: ["Transform", "MeshRenderer"], children: [] }] }
    const editor = fakeEditor({ get_scene_hierarchy: () => scene })
    const out = await editScene({ ...planner(editor.call), assetExists: () => false }, { operations: [raw] })
    expect(out).toContain("Scene changed")
    expect(editor.applied()![0]).toEqual({ command: "create_gameobject", params: { name: "Wheel_FL", primitive: "capsule", parent: "/Car" } })
    expect(out).toContain("Assets/Materials/Car_Wheel_FL.mat")
  })

  test("seen live: values wrapped in invented type tags", async () => {
    expect(unwrapTyped({ $float: 1500 })).toBe(1500)
    expect(unwrapTyped({ $vector3: [0, 30, 20] })).toEqual([0, 30, 20])
    expect(unwrapTyped({ type: "float", value: 2 })).toBe(2)
    expect(unwrapTyped({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 })

    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), {
      operations: [{ op: "set", target: "/Player", component: "Rigidbody", values: { mass: { $float: 1500 }, useGravity: { $bool: false }, drag: "0.1" } }],
    })
    expect(out).toContain("Scene changed")
    expect(editor.applied()![0]!.params.properties).toEqual({ m_Mass: 1500, m_UseGravity: false, m_Drag: 0.1 })
  })

  test("found by replaying that call live: a vector is one value, not a list of elements", async () => {
    const editor = fakeEditor()
    const edit = (offset: unknown) => editScene(planner(editor.call), { operations: [{ op: "add_component", target: "/Player", type: "Follower", values: { offset } }] })
    for (const offset of [[0, 30, 20], { $vector3: [0, 30, 20] }, { x: 0, y: 30, z: 20 }]) {
      expect(await edit(offset)).toContain("Scene changed")
      expect(editor.applied()!.at(-1)!.params.properties).toEqual({ offset: [0, 30, 20] })
    }
    expect(await edit([1, 2])).toContain("Follower.offset is a list of 3 numbers")
  })

  test("a value of the wrong kind is refused before Unity sees it, with the form it needs", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), { operations: [{ op: "set", target: "/Player", component: "Rigidbody", values: { mass: { heavy: true }, useGravity: "yes" } }] })
    expect(out).toContain("Rigidbody.mass is a number: write it bare, like 1")
    expect(out).toContain("Rigidbody.useGravity is true or false")
    expect(editor.applied()).toBeUndefined()
  })

  test("seen live: a hand-written material Unity cannot import", async () => {
    const twice = "%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n--- !u!114 &597\nMonoBehaviour:\n--- !u!21 &2100000\nMaterial:\n"
    expect(corruptAsset(twice)).toContain("two objects with the same id (&2100000)")
    expect(corruptAsset("%YAML 1.1\n--- !u!21 &1\n  m_Script: {fileID: 1, guid: dbcu5e1637534a74ba106c1d17ae168e, type: 3}\n")).toContain("invalid GUID")
    expect(corruptAsset("%YAML 1.1\n--- !u!21 &1\n  m_Shader: {fileID: 4800000, guid: 933532a4fcc9baf4fa0491de14d08ed7, type: 3}\n")).toBeNull()

    const renderer = { m_Materials: [{ instanceId: 1, type: "Material" }] }
    const scene: Hierarchy = { ...hierarchy, roots: [{ name: "Car", hierarchyPath: "/Car", components: ["Transform", "MeshRenderer"], children: [] }] }
    const editor = fakeEditor({ get_scene_hierarchy: () => scene, get_component_properties: () => ({ properties: renderer }) })
    const out = await editScene(
      { ...planner(editor.call), assetExists: () => true, readAsset: () => twice },
      { operations: [{ op: "set", target: "/Car", component: "MeshRenderer", values: { material: { path: "Assets/Materials/CarRed.mat" } } }] },
    )
    expect(out).toContain("exists but Unity cannot load it")
    expect(out).toContain('use "color"')
    expect(editor.applied()).toBeUndefined()
  })

  test("a field that cannot be understood is an error, never a silent no-op", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), { operations: [{ op: "create", name: "A", size: 3 }] })
    expect(out).toContain("Unknown field 'size'. Allowed fields: op, target, name")
    expect(editor.applied()).toBeUndefined()
  })

  test("the nested shapes are applied, not rejected", async () => {
    const editor = fakeEditor()
    const out = await editScene(planner(editor.call), { operations: [{ op: { create: ground } }, { create: { name: "TrackRing", primitive: "cylinder" } }] })
    expect(out).toContain("2 operations applied")
    expect(editor.applied()?.map((o) => o.params.name ?? o.command)).toEqual(["Ground", "set_transform", "TrackRing"])
  })

  test("what cannot be understood gets an error that shows the input and the right shape", async () => {
    const out = await editScene(planner(fakeEditor().call), { operations: [{ op: "paint", colour: "red" }] })
    expect(out).toContain("Unknown op 'paint'")
    expect(out).toContain('You sent: {"op":"paint","colour":"red"}')
    expect(out).toContain('Correct shape: {"op":"create"')
  })

  test('"material" sets the first element of the serialized materials array, and the asset must exist', async () => {
    const renderer = { m_Materials: [{ instanceId: 1, assetPath: "Resources/unity_builtin_extra", type: "Material" }], m_CastShadows: "On" }
    const withRenderer: Hierarchy = { ...hierarchy, roots: [{ name: "Ring", hierarchyPath: "/Ring", components: ["Transform", "MeshRenderer"], children: [] }] }
    const editor = fakeEditor({ get_scene_hierarchy: () => withRenderer, get_component_properties: () => ({ properties: renderer }) })
    const edit = (assetExists: (p: string) => boolean) =>
      editScene({ ...planner(editor.call), assetExists }, { operations: [{ op: "set", target: "/Ring", component: "MeshRenderer", values: { material: "Assets/Materials/Asphalt.mat" } }] })

    expect(await edit(() => false)).toContain("Asset 'Assets/Materials/Asphalt.mat' does not exist")

    // seen live: {"material": {"layer": "Assets/Materials/Asphalt.mat"}}. Unity rejects that handle and logs a Console error.
    const invented = (value: unknown) =>
      editScene({ ...planner(editor.call), assetExists: () => true }, { operations: [{ op: "set", target: "/Ring", component: "MeshRenderer", values: { material: value } }] })
    expect(await invented({ layer: "Assets/Materials/Asphalt.mat" })).toContain("Scene changed")
    expect(editor.applied()![0]!.params.properties).toEqual({ m_Materials: [{ path: "Assets/Materials/Asphalt.mat" }] })
    expect(await invented({ shader: "Lit", layer: "x" })).toContain("MeshRenderer.material is an object reference")
    expect(await edit(() => true)).toContain("Scene changed")
    expect(editor.applied()![0]!.params.properties).toEqual({ m_Materials: [{ path: "Assets/Materials/Asphalt.mat" }] })
  })
})

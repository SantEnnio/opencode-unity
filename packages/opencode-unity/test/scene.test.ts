import { describe, expect, test } from "bun:test"
import { editScene, friendlyName, type Hierarchy, type PipelineCall, resolveProperty, viewScene } from "../src/scene.ts"

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
        return { ok: true, result: { applied: ops.length, results: ops.map((o) => ({ command: o.command, success: true })) } }
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
    expect(out).toContain("Player  [Rigidbody]\n  Gun")
  })

  test("unknown path suggests the closest object", async () => {
    expect(await viewScene(fakeEditor().call, "/Playr")).toContain("Closest: /Player")
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
    expect(out).toContain("primitive 'plain' does not exist")
    expect(out).toContain("'/Player' already exists")
    expect(out).toContain("tag 'Hero' does not exist. Existing tags: Untagged, Player")
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
    expect(out).toContain("NOT saved")
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

  test("a failure inside Unity is mapped back to the model's own operation", async () => {
    const editor = fakeEditor({
      batch: (params) => ({ applied: 1, reverted: true, results: [{ command: "create_gameobject", success: true }, { command: "add_component", success: false, error: "Type 'Follower' is abstract" }] }),
    })
    const out = await editScene(planner(editor.call), { operations: [{ op: "create", name: "A" }, { op: "add_component", target: "/A", type: "Follower" }] })
    expect(out).toContain("rolled back")
    expect(out).toContain("Operation 2 (add_component) failed in Unity: Type 'Follower' is abstract")
  })

  test("dry run and save", async () => {
    const editor = fakeEditor()
    expect(await editScene(planner(editor.call), { operations: [{ op: "create", name: "A" }], dryRun: true })).toContain("Valid")
    expect(editor.applied()).toBeUndefined()
    expect(await editScene(planner(editor.call), { operations: [{ op: "create", name: "A" }], save: true })).toContain("Saved Assets/Scenes/Main.unity")
    expect(editor.calls.at(-1)?.command).toBe("save_scene")
  })
})

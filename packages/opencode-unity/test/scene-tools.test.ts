import { describe, expect, test } from "bun:test"
import type { PipelineCall } from "../src/scene.ts"
import { parseValues, parseVector, sceneTools } from "../src/scene-tools.ts"

describe("plain-text arguments", () => {
  test.each([
    ["0, 1.5, -3", [0, 1.5, -3]],
    ["0 1.5 -3", [0, 1.5, -3]],
    ["(0,1.5,-3)", [0, 1.5, -3]],
    ["[0, 1.5, -3]", [0, 1.5, -3]],
    ["x=0 y=1.5 z=-3", [0, 1.5, -3]],
  ])("vector %s", (text, expected) => {
    expect(parseVector(text, "position")).toEqual(expected)
  })

  test("vector edge cases", () => {
    expect(parseVector(undefined, "position")).toBeUndefined()
    expect(parseVector("2", "scale")).toEqual([2, 2, 2])
    expect(parseVector("1, 2", "position")).toContain("must be 3 numbers")
    expect(parseVector("up", "position")).toContain('You wrote "up"')
  })

  test("values: numbers, switches, vectors, references, text", () => {
    expect(parseValues("mass=1500; useGravity=true; offset=0, 3, -6; target=/Car; interpolate=Interpolate; drag=0.1f")).toEqual({
      mass: 1500,
      useGravity: true,
      offset: [0, 3, -6],
      target: "/Car",
      interpolate: "Interpolate",
      drag: 0.1,
    })
  })

  test("values: the ways a model separates and quotes them", () => {
    expect(parseValues("mass: 2, isKinematic: false")).toEqual({ mass: 2, isKinematic: false })
    expect(parseValues('{"mass": 2, "material": "Assets/Materials/Red.mat"}')).toEqual({ mass: 2, material: "Assets/Materials/Red.mat" })
    expect(parseValues("offset=(0, 3, -6)\nspeed=5")).toEqual({ offset: [0, 3, -6], speed: 5 })
    expect(parseValues("fast")).toContain("name=value")
  })
})

describe("flat scene tools", () => {
  const calls: { command: string; params: any }[] = []
  const call: PipelineCall = async (command, rawParams = {}) => {
    const params = rawParams as any
    calls.push({ command, params })
    if (command === "get_scene_hierarchy") {
      return { ok: true, result: { sceneName: "Main", scenePath: "Assets/Main.unity", isDirty: false, roots: [{ name: "Car", hierarchyPath: "/Car", components: ["Transform", "Rigidbody"], children: [] }] } }
    }
    if (command === "get_component_properties") return { ok: true, result: { properties: { m_Mass: 1, m_UseGravity: true } } }
    if (command === "find_gameobjects") return { ok: true, result: { count: params.hierarchy_path === "/Car" ? 1 : 0 } }
    if (command === "batch") return { ok: true, result: { applied: params.operations.length, results: params.operations.map((o: any) => ({ command: o.command, success: true })) } }
    return { ok: true, result: {} }
  }
  const failures = new Map<string, number>()
  const tools = sceneTools({
    connect: async () => ({ call, graph: null, scripts: new Set(["CarController"]), assetExists: (asset) => asset === "Assets/Prefabs/Cone.prefab", readAsset: () => null }),
    notConnected: async () => "NOT CONNECTED",
    breakLoop: (_s, name, _i, output, failed) => (failures.set(name, failed ? (failures.get(name) ?? 0) + 1 : 0), output),
    stuck: () => null,
  })
  const context = { directory: "/p", sessionID: "s", abort: new AbortController().signal } as never
  const batch = () => calls.filter((c) => c.command === "batch").at(-1)!.params.operations

  test("create: the case that broke as nested JSON (parent + shape) is just flat arguments", async () => {
    const out = await tools.unity_object_create!.execute({ name: "Wheel_FL", shape: "cylinder", parent: "/Car", position: "-0.6, -0.25, 0.8", scale: "0.5, 0.1, 0.5", components: "SphereCollider" }, context)
    expect(out).toContain("Scene changed")
    expect(batch()).toEqual([
      { command: "create_gameobject", params: { name: "Wheel_FL", primitive: "cylinder", parent: "/Car" } },
      { command: "set_transform", params: { target: "/Car/Wheel_FL", position: [-0.6, -0.25, 0.8], scale: [0.5, 0.1, 0.5] } },
      { command: "add_component", params: { target: "/Car/Wheel_FL", type: "SphereCollider" } },
    ])
  })

  test("set: values arrive as text and leave as typed properties", async () => {
    const out = await tools.unity_component_set!.execute({ path: "/Car", component: "Rigidbody", values: "mass=1500; useGravity=false" }, context)
    expect(out).toContain("Scene changed")
    expect(batch()).toEqual([{ command: "set_component_properties", params: { target: "/Car", type: "Rigidbody", properties: { m_Mass: 1500, m_UseGravity: false } } }])
  })

  test("bad text is refused with the form to use, and counted as a failure", async () => {
    const out = await tools.unity_object_modify!.execute({ path: "/Car", position: "up a bit" }, context)
    expect(out).toContain("Scene NOT changed: 'position' must be 3 numbers")
    expect(failures.get("unity_object_modify")).toBe(1)
  })

  test("prefab: create from a scene object, refuse duplicates and missing objects, place copies", async () => {
    expect(await tools.unity_prefab_create!.execute({ path: "/Car" }, context)).toContain("Prefab saved as Assets/Prefabs/Car.prefab")
    expect(calls.at(-1)).toEqual({ command: "create_prefab", params: { source: "/Car", path: "Assets/Prefabs/Car.prefab" } })
    expect(await tools.unity_prefab_create!.execute({ path: "/Ghost" }, context)).toContain("there is no object at '/Ghost'")
    expect(await tools.unity_prefab_create!.execute({ path: "/Car", prefab: "Prefabs/Cone" }, context)).toContain("'Assets/Prefabs/Cone.prefab' already exists")

    expect(await tools.unity_prefab_place!.execute({ prefab: "Assets/Prefabs/Cone.prefab", name: "Cone_1", parent: "/Car", position: "3, 0, 0" }, context)).toContain("Scene changed")
    expect(batch().map((o: any) => o.command)).toEqual(["instantiate_prefab", "set_parent", "set_transform"])
    expect(await tools.unity_prefab_place!.execute({ prefab: "Assets/Prefabs/Nope.prefab" }, context)).toContain("Create it first from a scene object with unity_prefab_create")
  })
})

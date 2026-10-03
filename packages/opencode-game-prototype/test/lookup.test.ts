import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createLookup } from "../src/lookup.ts"

const lookup = createLookup(path.join(import.meta.dir, "..", "node_modules", "three", "build"), "r186")

describe("proto_lookup", () => {
  test("a class: its fields and methods, read from the build", async () => {
    const text = await lookup("Mesh")
    expect(text).toContain("[proto] THREE.Mesh in three.js r186:")
    expect(text).toMatch(/fields: .*position.*material/)
    expect(text).toMatch(/methods: .*lookAt/)
  })

  test("a member that exists, one that does not, with the closest names", async () => {
    expect(await lookup("Vector3.distanceTo")).toBe("[proto] THREE.Vector3.distanceTo exists: a method of Vector3.")
    expect(await lookup("THREE.Object3D.lookAt()")).toBe("[proto] THREE.Object3D.lookAt exists: a method of Object3D.")
    expect(await lookup("Vector3.distance")).toContain("[proto] THREE.Vector3 has no distance. Closest: distanceTo, distanceToSquared")
  })

  test("a class that needs a browser is read from the source instead", async () => {
    expect(await lookup("WebGLRenderer.setSize")).toBe("[proto] THREE.WebGLRenderer.setSize exists: a method of WebGLRenderer.")
    expect(await lookup("WebGLRenderer")).toMatch(/fields: .*domElement/)
  })

  test("a namespace, a removed class, a wrong spelling", async () => {
    expect(await lookup("MathUtils.clamp")).toBe("[proto] THREE.MathUtils.clamp exists.")
    expect(await lookup("Geometry")).toBe("[proto] three.js r186 has no THREE.Geometry: use THREE.BufferGeometry.")
    expect(await lookup("MeshStandartMaterial")).toContain("the closest names are THREE.MeshStandardMaterial")
  })
})

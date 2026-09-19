import { Database } from "../src/sqlite.ts"
import { describe, expect, test } from "bun:test"
import { ingest } from "../src/graph/build.ts"
import { SymbolGraph } from "../src/graph/db.ts"
import { lookup } from "../src/lookup.ts"
import { parseCliJson } from "../src/unity/cli.ts"
import { parseNUnit, renderTests } from "../src/unity/nunit.ts"
import { renderRules } from "../src/rules.ts"

function graph(): SymbolGraph {
  const db = new Database(":memory:")
  const type = (full: string, kind: string, members: object[], extra: object = {}) => {
    const simple = full.slice(full.lastIndexOf(".") + 1)
    return { asm: "Test", ns: full.slice(0, full.lastIndexOf(".")), name: simple, simple, full, kind, members, ...extra }
  }
  ingest(
    db,
    [
      type("UnityEngine.Component", "class", [{ name: "GetComponent", kind: "method", sig: "public T GetComponent<T>()" }]),
      type(
        "UnityEngine.Rigidbody",
        "class",
        [
          { name: "AddForce", kind: "method", sig: "public void AddForce(Vector3 force)", summary: "Adds a force to the Rigidbody." },
          { name: "AddForce", kind: "method", sig: "public void AddForce(Vector3 force, ForceMode mode)" },
          { name: "linearVelocity", kind: "property", sig: "public Vector3 linearVelocity { get; set; }" },
          { name: "velocity", kind: "property", sig: "public Vector3 velocity { get; set; }", obsolete: { message: "Use linearVelocity. (UnityUpgradable) -> linearVelocity", error: false } },
        ],
        { base: "UnityEngine.Component", summary: "Physics body." },
      ),
      type("UnityEngine.Rigidbody2D", "class", [{ name: "AddForce", kind: "method", sig: "public void AddForce(Vector2 force)" }]),
    ] as never,
    { fingerprint: "test" },
  )
  return new SymbolGraph([db])
}

describe("lookup", () => {
  const g = graph()

  test("type overview groups members and points at the next call", () => {
    const out = lookup(g, "rigidbody")
    expect(out).toContain("class UnityEngine.Rigidbody : Component")
    expect(out).toContain("public void AddForce(Vector3 force)   (+1 overloads)")
    expect(out).not.toContain("public Vector3 velocity")
    expect(out).toContain("Also inherits 1 members from Component")
    expect(out).toContain('unity_lookup("Rigidbody.<member>")')
  })

  test("member lookup is forgiving about separators and case", () => {
    for (const query of ["Rigidbody.AddForce", "rigidbody addforce", "UnityEngine.Rigidbody.AddForce(Vector3)", "Rigidbody::addForce"]) {
      const out = lookup(g, query, () => "rb.AddForce(Vector3.up);")
      expect(out).toContain("public void AddForce(Vector3 force, ForceMode mode)")
      expect(out).toContain("Example:\nrb.AddForce(Vector3.up);")
    }
    expect(lookup(g, "Rigidbody.GetComponent")).toContain("Inherited from Component.")
  })

  test("obsolete members lead to their replacement", () => {
    const out = lookup(g, "Rigidbody.velocity")
    expect(out).toContain("OBSOLETE")
    expect(out).toContain('→ unity_lookup("Rigidbody.linearVelocity")')
  })

  test("misses always offer a way forward", () => {
    expect(lookup(g, "Rigidbody.AddForc")).toContain("Closest real members")
    expect(lookup(g, "AddForce")).toContain("'AddForce' is a member of 2 types")
    expect(lookup(g, "Rigidbdy")).toContain('→ unity_lookup("Rigidbody")')
    expect(lookup(g, "QuantumFlux")).toContain("Do not use it")
  })
})

describe("unity cli helpers", () => {
  test("parseCliJson skips the Editor log printed before the envelope", () => {
    const out = `Unity Editor version: 6000\n{ "noise": 1 }\n{\n  "success": true,\n  "data": { "count": 1 },\n  "errors": []\n}`
    expect(parseCliJson(out)).toEqual({ success: true, data: { count: 1 }, errors: [] })
    expect(parseCliJson("not json")).toBeNull()
  })

  test("NUnit results", () => {
    const xml = `<?xml version="1.0"?><test-run total="3" passed="1" failed="1" skipped="1" inconclusive="0">
      <test-case name="A" fullname="Game.Tests.A" result="Passed" />
      <test-case name="B" fullname="Game.Tests.B" result="Failed"><failure><message><![CDATA[Expected: 1
  But was: 2]]></message><stack-trace><![CDATA[at Game.Tests.B () in Assets/Tests/T.cs:12]]></stack-trace></failure></test-case>
      <test-case name="C" fullname="Game.Tests.C" result="Skipped" /></test-run>`
    const summary = parseNUnit(xml)
    expect(summary).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 })
    expect(summary.failures).toEqual([{ name: "Game.Tests.B", message: "Expected: 1\n  But was: 2", stack: "at Game.Tests.B () in Assets/Tests/T.cs:12" }])
    expect(renderTests(summary)).toContain("1) Game.Tests.B")
    expect(renderTests({ total: 0, passed: 0, failed: 0, skipped: 0, failures: [] })).toContain("No tests were found")
  })

  test("rules block states the project facts", () => {
    const rules = renderRules({ version: "6000.0.71f1", inputHandler: 1, renderPipeline: "URP", packages: ["Input System", "Cinemachine"] })
    expect(rules).toContain("Unity 6000.0.71f1, URP render pipeline")
    expect(rules).toContain("Installed packages: Input System, Cinemachine.")
    expect(rules).toContain("UnityEngine.Input throws at runtime")
    expect(rules.split("\n").length).toBeLessThan(14)
  })
})

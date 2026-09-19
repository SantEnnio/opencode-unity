import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { Diagnostic } from "../src/compile/diagnostics.ts"
import { calleeAt, declaredType, Enricher, similarity, splitSymbol } from "../src/enrich.ts"
import { cleanObsoleteMessage, ingest, parseReplacement } from "../src/graph/build.ts"
import { stripGenerics, SymbolGraph } from "../src/graph/db.ts"

const member = (name: string, sig: string, extra: object = {}) => ({ name, kind: "property", sig, ...extra })
const type = (full: string, kind: string, members: object[], extra: object = {}) => {
  const simple = full.slice(full.lastIndexOf(".") + 1)
  return { asm: "Test", ns: full.slice(0, full.lastIndexOf(".")), name: simple, simple, full, kind, members, ...extra }
}

function graph(): SymbolGraph {
  const db = new Database(":memory:")
  ingest(
    db,
    [
      type("UnityEngine.Component", "class", [member("transform", "public Transform transform { get; }")]),
      type(
        "UnityEngine.Rigidbody",
        "class",
        [
          member("linearVelocity", "public Vector3 linearVelocity { get; set; }"),
          member("velocity", "public Vector3 velocity { get; set; }", {
            obsolete: { message: "Please use Rigidbody.linearVelocity instead. (UnityUpgradable) -> linearVelocity", error: false },
          }),
          { name: "AddForce", kind: "method", sig: "public void AddForce(Vector3 force)" },
        ],
        { base: "UnityEngine.Component" },
      ),
      type("UnityEngine.Rigidbody2D", "class", [{ name: "AddForce", kind: "method", sig: "public void AddForce(Vector2 force)" }]),
      type("UnityEngine.PrimitiveType", "enum", [
        { name: "Sphere", kind: "enumvalue", sig: "PrimitiveType.Sphere = 0" },
        { name: "Cube", kind: "enumvalue", sig: "PrimitiveType.Cube = 3" },
      ]),
      type("UnityEngine.UI.Button", "class", []),
      type("UnityEngine.UIElements.Button", "class", []),
    ] as never,
    { fingerprint: "test" },
  )
  return new SymbolGraph([db])
}

const diagnostic = (code: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "Assets/A.cs",
  line: 1,
  column: 1,
  severity: "error",
  code,
  message,
  ...extra,
})

const enricher = (source = "") => new Enricher(graph(), { text: () => source })

describe("helpers", () => {
  test("stripGenerics", () => {
    expect(stripGenerics("UnityEngine.Events.UnityEvent<T0>")).toBe("UnityEngine.Events.UnityEvent")
    expect(stripGenerics("System.Collections.Generic.List<int>[]")).toBe("System.Collections.Generic.List")
  })

  test("parseReplacement", () => {
    expect(parseReplacement("Please use Rigidbody.linearVelocity instead. (UnityUpgradable) -> linearVelocity")).toBe("linearVelocity")
    expect(parseReplacement("(UnityUpgradable) -> [UnityEngine] UnityEngine.Foo.Bar(*)")).toBe("UnityEngine.Foo.Bar")
    expect(parseReplacement("Object.FindObjectOfType has been deprecated. Use Object.FindFirstObjectByType instead")).toBe(
      "Object.FindFirstObjectByType",
    )
    expect(parseReplacement("This is going away.")).toBeNull()
    expect(cleanObsoleteMessage("Use x. (UnityUpgradable) -> x")).toBe("Use x.")
  })

  test("similarity ranks case mistakes first and rejects unrelated names", () => {
    expect(similarity("velocity", "Velocity")).toBe(0)
    expect(similarity("linearVelocity", "Velocity")!).toBeLessThan(similarity("SetPositionAndRotation", "SetPos")! + 1)
    expect(similarity("mass", "SetPos")).toBeNull()
  })

  test("splitSymbol", () => {
    expect(splitSymbol("Object.FindObjectOfType<T>()")).toEqual({ type: "Object", member: "FindObjectOfType" })
    expect(splitSymbol("Rigidbody.AddForce(Vector3, ForceMode)")).toEqual({ type: "Rigidbody", member: "AddForce" })
    expect(splitSymbol("GUIText")).toEqual({ type: "GUIText", member: null })
  })

  test("calleeAt finds the enclosing call and its receiver", () => {
    expect(calleeAt("            rb.AddForce(0f, 5f);", 25)).toEqual({ name: "AddForce", receiver: "rb" })
    expect(calleeAt("var x = Foo(Bar(1), 2);", 21)).toEqual({ name: "Foo", receiver: null })
    expect(calleeAt("var c = GetComponent<Rigidbody>(1);", 33)).toEqual({ name: "GetComponent", receiver: null })
  })

  test("declaredType", () => {
    expect(declaredType("    private Rigidbody rb;\n", "rb")).toBe("Rigidbody")
    expect(declaredType("void F(List<int> items) {}", "items")).toBe("List<int>")
    expect(declaredType("rb = 1;", "rb")).toBeNull()
  })
})

describe("Enricher", () => {
  test("CS1061: suggests real members, inherited ones included", () => {
    const hints = enricher().hints(diagnostic("CS1061", "'Rigidbody' does not contain a definition for 'Velocity' and no accessible..."))
    expect(hints[0]).toContain("UnityEngine.Rigidbody has no member 'Velocity'")
    expect(hints.join("\n")).toContain("linearVelocity")
    expect(hints.join("\n")).toContain("[OBSOLETE, use linearVelocity]")
    expect(enricher().hints(diagnostic("CS1061", "'Rigidbody' does not contain a definition for 'Transform'")).join("\n")).toContain(
      "public Transform transform",
    )
  })

  test("CS0117 on an enum lists the valid values", () => {
    const hints = enricher().hints(diagnostic("CS0117", "'PrimitiveType' does not contain a definition for 'Torus'"))
    expect(hints).toEqual(["PrimitiveType.Torus does not exist. The only PrimitiveType values are: Sphere, Cube."])
  })

  test("CS0246: a type whose namespace is already imported is an assembly reference problem", () => {
    const hints = enricher("using UnityEngine;").hints(diagnostic("CS0246", "The type or namespace name 'Rigidbody2D' could not be found (are you...)"))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain("does not reference it")
  })

  test("CS0246: ambiguous simple names are all offered", () => {
    const hints = enricher("using UnityEngine;").hints(diagnostic("CS0246", "The type or namespace name 'Button' could not be found"))
    expect(hints).toHaveLength(2)
    expect(hints[0]).toContain("using UnityEngine.UI;")
    expect(hints[1]).toContain("using UnityEngine.UIElements;")
  })

  test("CS0246: unknown type", () => {
    const hints = enricher().hints(diagnostic("CS0246", "The type or namespace name 'SuperCollider' could not be found"))
    expect(hints[0]).toContain("No type named 'SuperCollider'")
  })

  test("CS0103 stays silent for plain undeclared variables", () => {
    expect(enricher().hints(diagnostic("CS0103", "The name 'speed' does not exist in the current context"))).toEqual([])
  })

  test("CS0618: points at the replacement with its signature", () => {
    const hints = enricher().hints(
      diagnostic("CS0618", "'Rigidbody.velocity' is obsolete: 'Please use Rigidbody.linearVelocity instead.'", { severity: "warning" }),
    )
    expect(hints[0]).toBe("Replace velocity with linearVelocity.")
    expect(hints[1]).toContain("public Vector3 linearVelocity { get; set; }")
  })

  test("CS1503: narrows overloads through the receiver's declared type", () => {
    const source = "Rigidbody rb;\nvoid F() { rb.AddForce(1f); }"
    const hints = enricher(source).hints(
      diagnostic("CS1503", "Argument 1: cannot convert from 'float' to 'UnityEngine.Vector3'", { line: 2, column: 24 }),
    )
    expect(hints).toEqual(["Real overloads of AddForce:", "  Rigidbody: public void AddForce(Vector3 force)"])
  })
})

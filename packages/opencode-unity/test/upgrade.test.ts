import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Diagnostic } from "../src/compile/diagnostics.ts"
import { applyUpgrades, upgradesFrom } from "../src/compile/upgrade.ts"

// Real CS0618 messages from dotnet build against Unity 6000.0.71f1's assemblies.
const warning = (line: number, column: number, message: string): Diagnostic => ({ file: "Assets/Scripts/ApiProbe.cs", line, column, severity: "warning", code: "CS0618", message })
const diagnostics = [
  warning(10, 9, "'Rigidbody.velocity' is obsolete: 'Please use Rigidbody.linearVelocity instead. (UnityUpgradable) -> linearVelocity'"),
  warning(11, 9, "'Rigidbody.drag' is obsolete: 'Please use Rigidbody.linearDamping instead. (UnityUpgradable) -> linearDamping'"),
  warning(12, 19, "'Rigidbody.angularDrag' is obsolete: 'Please use Rigidbody.angularDamping instead. (UnityUpgradable) -> angularDamping'"),
  warning(13, 21, "'Object.FindObjectOfType<T>()' is obsolete: 'Object.FindObjectOfType has been deprecated. Use Object.FindFirstObjectByType instead or if finding any instance is acceptable the faster Object.FindAnyObjectByType'"),
]

describe("Unity's own API renames", () => {
  test("only what Unity marks as upgradable, and only plain renames", () => {
    expect(upgradesFrom(diagnostics).map((u) => `${u.line}:${u.from}->${u.to}`)).toEqual(["10:velocity->linearVelocity", "11:drag->linearDamping", "12:angularDrag->angularDamping"])
    // A target in another assembly or with a different shape stays a hint for the model.
    expect(upgradesFrom([warning(1, 1, "'Foo.Bar' is obsolete: 'x (UnityUpgradable) -> [UnityEngine.CoreModule] UnityEngine.Baz'")])).toEqual([])
    expect(upgradesFrom([warning(1, 1, "'Foo.Bar()' is obsolete: 'x (UnityUpgradable) -> *Baz(*)'")])).toEqual([])
  })

  test("rewrites at the compiler's position, keeps line endings, reports whole lines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-upgrade-"))
    try {
      const file = path.join(root, "Assets", "Scripts", "ApiProbe.cs")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const lines = Array.from({ length: 14 }, () => "")
      lines[9] = "        rb.velocity = Vector3.zero;"
      lines[10] = "        rb.drag = 0.5f; // drag stays in comments? no: only the use is renamed"
      lines[11] = "        float d = rb.angularDrag;"
      lines[12] = "        var other = FindObjectOfType<Camera>();"
      fs.writeFileSync(file, lines.join("\r\n"))

      const changed = applyUpgrades(root, upgradesFrom(diagnostics))
      expect(changed.map((c) => [c.line, c.before, c.after])).toEqual([
        [10, "rb.velocity = Vector3.zero;", "rb.linearVelocity = Vector3.zero;"],
        [11, "rb.drag = 0.5f; // drag stays in comments? no: only the use is renamed", "rb.linearDamping = 0.5f; // drag stays in comments? no: only the use is renamed"],
        [12, "float d = rb.angularDrag;", "float d = rb.angularDamping;"],
      ])
      const text = fs.readFileSync(file, "utf8")
      expect(text).toContain("\r\n")
      expect(text).toContain("FindObjectOfType<Camera>()")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("two renames on one line both apply, and the report shows the final line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-upgrade-"))
    try {
      fs.mkdirSync(path.join(root, "Assets"), { recursive: true })
      fs.writeFileSync(path.join(root, "Assets", "A.cs"), "a.velocity = b.velocity * a.drag;")
      const on = (column: number, from: string, to: string): Diagnostic => ({ file: "Assets/A.cs", line: 1, column, severity: "warning", code: "CS0618", message: `'Rigidbody.${from}' is obsolete: 'x (UnityUpgradable) -> ${to}'` })
      const changed = applyUpgrades(root, upgradesFrom([on(1, "velocity", "linearVelocity"), on(14, "velocity", "linearVelocity"), on(27, "drag", "linearDamping")]))
      expect(fs.readFileSync(path.join(root, "Assets", "A.cs"), "utf8")).toBe("a.linearVelocity = b.linearVelocity * a.linearDamping;")
      expect(new Set(changed.map((c) => c.after))).toEqual(new Set(["a.linearVelocity = b.linearVelocity * a.linearDamping;"]))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { parseDiagnostics } from "../src/compile/diagnostics.ts"

const root = process.platform === "win32" ? "C:\\proj\\My project" : "/proj/My project"
const abs = (rel: string) => (process.platform === "win32" ? `${root}\\${rel.replaceAll("/", "\\")}` : `${root}/${rel}`)

describe("parseDiagnostics", () => {
  test("parses MSBuild output, strips the project suffix and de-duplicates", () => {
    const line = `${abs("Assets/Scripts/A.cs")}(113,74): error CS0117: 'PrimitiveType' does not contain a definition for 'Torus' [${abs("Assembly-CSharp.csproj")}]`
    const result = parseDiagnostics([line, line, "CSC : warning CS8032: analyzer noise"].join("\n"), root)
    expect(result).toEqual([
      {
        file: "Assets/Scripts/A.cs",
        line: 113,
        column: 74,
        severity: "error",
        code: "CS0117",
        message: "'PrimitiveType' does not contain a definition for 'Torus'",
      },
    ])
  })

  test("keeps brackets that belong to the message", () => {
    const line = `Assets/A.cs(1,2): error CS0029: Cannot implicitly convert type 'int[]' to 'float[]'`
    expect(parseDiagnostics(line, root)[0]?.message).toBe("Cannot implicitly convert type 'int[]' to 'float[]'")
  })

  test("parses Unity Editor log lines (relative path, CRLF)", () => {
    const result = parseDiagnostics("Assets/A.cs(3,5): warning CS0618: 'X.y' is obsolete: 'Use z'\r\n", root)
    expect(result[0]).toMatchObject({ file: "Assets/A.cs", severity: "warning", code: "CS0618" })
  })
})

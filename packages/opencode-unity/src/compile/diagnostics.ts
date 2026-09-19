import path from "node:path"

export type Diagnostic = {
  /** Relative to the Unity project root, forward slashes */
  file: string
  line: number
  column: number
  severity: "error" | "warning"
  code: string
  message: string
}

// Same shape for `dotnet build` output and for the Unity Editor log; MSBuild appends "[project.csproj]".
const DIAGNOSTIC =
  /^\s*(?<file>.+?)\((?<line>\d+),(?<column>\d+)(?:,\d+,\d+)?\):\s+(?<severity>error|warning)\s+(?<code>[A-Za-z]+\d+):\s+(?<message>.*?)(?:\s+\[[^[\]]+proj\])?\s*$/

export function toProjectPath(file: string, projectRoot: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(projectRoot, file)
  const relative = path.relative(projectRoot, absolute)
  return (relative.startsWith("..") ? absolute : relative).split(path.sep).join("/")
}

export function parseDiagnostics(output: string, projectRoot: string): Diagnostic[] {
  const seen = new Set<string>()
  const diagnostics: Diagnostic[] = []
  for (const raw of output.split(/\r?\n/)) {
    const groups = DIAGNOSTIC.exec(raw)?.groups
    if (!groups) continue
    const diagnostic: Diagnostic = {
      file: toProjectPath(groups.file!, projectRoot),
      line: Number(groups.line),
      column: Number(groups.column),
      severity: groups.severity as Diagnostic["severity"],
      code: groups.code!.toUpperCase(),
      message: groups.message!,
    }
    // MSBuild repeats every diagnostic in its summary and once per referencing project.
    const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}`
    if (seen.has(key)) continue
    seen.add(key)
    diagnostics.push(diagnostic)
  }
  return diagnostics
}

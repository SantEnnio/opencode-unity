import fs from "node:fs"
import path from "node:path"
import { type Diagnostic, parseDiagnostics, toProjectPath } from "./diagnostics.ts"
import { run } from "../runtime.ts"
import { buildEntryPoints, listProjectFiles, reconcile, renderTargets } from "./reconcile.ts"

export type CompileResult =
  | { status: "ok" | "errors"; diagnostics: Diagnostic[]; unchecked: string[]; durationMs: number }
  | { status: "unavailable"; reason: string }

export type CompileOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 120_000

// Compiler messages are matched with regexes further down: keep them in English on every machine.
const BUILD_ENV = {
  DOTNET_CLI_UI_LANGUAGE: "en",
  DOTNET_NOLOGO: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
}

/**
 * Compiles the Unity-generated C# projects with `dotnet build`. Works while the Editor has the
 * project open (unlike -batchmode) and only writes below Temp/ and Library/OpencodeUnity/.
 */
export async function compileWithDotnet(projectRoot: string, options: CompileOptions = {}): Promise<CompileResult> {
  const projects = listProjectFiles(projectRoot)
  if (projects.length === 0) {
    return {
      status: "unavailable",
      reason:
        "no .csproj files in the Unity project root. Open the project in the Unity Editor with an external script editor selected (Preferences > External Tools) so they get generated. Until then, call unity_compile for a full (slower) compile by Unity itself.",
    }
  }

  const reconciliation = reconcile(projectRoot, projects)
  const args = ["-nologo", "-v:q", "-clp:NoSummary", "-p:GenerateFullPaths=true"]
  if (reconciliation.added.size > 0 || reconciliation.removed.size > 0) {
    const targets = path.join(projectRoot, "Library", "OpencodeUnity", "sources.targets")
    fs.mkdirSync(path.dirname(targets), { recursive: true })
    fs.writeFileSync(targets, renderTargets(reconciliation))
    args.push(`-p:CustomAfterMicrosoftCommonTargets=${targets}`)
  }

  const started = Date.now()
  const diagnostics: Diagnostic[] = []
  const seen = new Set<string>()
  for (const project of buildEntryPoints(projects)) {
    let result: { exitCode: number; output: string }
    try {
      const build = await run(["dotnet", "build", project.path, ...args], {
        cwd: projectRoot,
        env: BUILD_ENV,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      })
      result = { exitCode: build.exitCode, output: `${build.stdout}\n${build.stderr}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const missing = /ENOENT|not found|No such file/i.test(message)
      return {
        status: "unavailable",
        reason: missing ? "the .NET SDK is not installed (`dotnet` was not found on PATH)" : message,
      }
    }

    const parsed = parseDiagnostics(result.output, projectRoot)
    if (result.exitCode !== 0 && !parsed.some((d) => d.severity === "error")) {
      const tail = result.output.trim().split(/\r?\n/).slice(-6).join("\n")
      return { status: "unavailable", reason: `dotnet build failed without compiler errors:\n${tail}` }
    }
    for (const d of parsed) {
      const key = `${d.file}:${d.line}:${d.column}:${d.code}`
      if (!seen.has(key)) {
        seen.add(key)
        diagnostics.push(d)
      }
    }
  }

  return {
    status: diagnostics.some((d) => d.severity === "error") ? "errors" : "ok",
    diagnostics,
    unchecked: reconciliation.unchecked.map((f) => toProjectPath(f, projectRoot)),
    durationMs: Date.now() - started,
  }
}

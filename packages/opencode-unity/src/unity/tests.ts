import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run, type RunOptions } from "../runtime.ts"
import { editorCommand, editorConnected, editorHasProjectOpen, findUnityCli } from "./cli.ts"
import { findEditor, findEditorExecutable, type UnityProject } from "./discovery.ts"
import { parseNUnit, renderTests, type TestSummary } from "./nunit.ts"

export type TestMode = "EditMode" | "PlayMode"

type PipelineTests = {
  Summary?: { Total?: number; Passed?: number; Failed?: number; Skipped?: number; Inconclusive?: number }
  Results?: { FullName?: string; Status?: string; Message?: string; StackTrace?: string }[]
}

function fromPipeline(result: PipelineTests): TestSummary {
  const s = result.Summary ?? {}
  return {
    total: s.Total ?? 0,
    passed: s.Passed ?? 0,
    failed: s.Failed ?? 0,
    skipped: (s.Skipped ?? 0) + (s.Inconclusive ?? 0),
    failures: (result.Results ?? [])
      .filter((r) => /fail|error/i.test(r.Status ?? ""))
      .map((r) => ({ name: r.FullName ?? "?", message: r.Message ?? "", stack: (r.StackTrace ?? "").split("\n").slice(0, 4).join("\n") })),
  }
}

/** Runs the project's tests through whichever route is possible right now and renders the outcome. */
export async function runTests(project: UnityProject, mode: TestMode, filter: string | undefined, editorPath: string | undefined, options: RunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 900_000

  if (await editorConnected(project.root, options)) {
    const args: Record<string, string | number> = { mode: mode === "EditMode" ? "editor" : "playmode", timeout: Math.floor(timeoutMs / 1000) }
    if (filter) args.filter = filter
    const response = await editorCommand(project.root, "run_tests", args, { ...options, timeoutMs })
    if (!response.success) return `[unity] Tests could not run in the open Editor: ${response.errors[0]?.message ?? "unknown error"}`
    const result = (response.data as { result?: PipelineTests | string } | null)?.result
    const parsed = typeof result === "string" ? (JSON.parse(result) as PipelineTests) : (result ?? {})
    return renderTests(fromPipeline(parsed))
  }

  if (editorHasProjectOpen(project.root)) {
    return "[unity] The Unity Editor has this project open, so tests cannot run from the command line. Ask the user to either run them in Window > General > Test Runner, install the Pipeline package (`unity pipeline install`) so the open Editor can be driven, or close the Editor."
  }

  const results = path.join(os.tmpdir(), `opencode-unity-tests-${process.pid}-${Date.now()}.xml`)
  try {
    const cli = findUnityCli()
    if (cli) {
      const args = ["test", project.root, "--mode", mode, "--output", results, "--timeout", String(Math.floor(timeoutMs / 1000))]
      if (filter) args.push("--filter", filter)
      await run([cli, ...args], { ...options, timeoutMs: timeoutMs + 30_000, env: { UNITY_NO_BANNER: "1", UNITY_NON_INTERACTIVE: "1" } })
    } else {
      const editor = findEditor(project.version, { editorPath })
      const executable = editor ? findEditorExecutable(editor.root) : null
      if (!executable) return `[unity] Unity ${project.version} is not installed: tests cannot run.`
      // No -quit: with -runTests it makes the Editor exit before the tests finish.
      const args = ["-batchmode", "-nographics", "-projectPath", project.root, "-runTests", "-testPlatform", mode, "-testResults", results, "-logFile", `${results}.log`]
      if (filter) args.push("-testFilter", filter)
      await run([executable, ...args], { ...options, timeoutMs })
    }
    if (!fs.existsSync(results)) return "[unity] The test run produced no results file: the project probably has compile errors. Run unity_compile first."
    return renderTests(parseNUnit(fs.readFileSync(results, "utf8")))
  } catch (error) {
    return `[unity] Test run failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    fs.rmSync(results, { force: true })
    fs.rmSync(`${results}.log`, { force: true })
  }
}

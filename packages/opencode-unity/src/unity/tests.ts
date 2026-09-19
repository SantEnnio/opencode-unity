import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run, type RunOptions } from "../runtime.ts"
import { commandResult, editorCommand, editorConnected, editorHasProjectOpen, findUnityCli } from "./cli.ts"
import { findEditor, findEditorExecutable, type UnityProject } from "./discovery.ts"
import { parseNUnit, renderTests, type TestSummary } from "./nunit.ts"

export type TestMode = "EditMode" | "PlayMode"

type PipelineResult = { FullName?: string; Status?: string; Message?: string | null; StackTrace?: string | null }
type PipelineStatus = {
  status?: string
  summary?: { total?: number; passed?: number; failed?: number; skipped?: number; inconclusive?: number }
  results?: PipelineResult[]
}

const POLL_MS = 1_500

function fromPipeline(status: PipelineStatus): TestSummary {
  const s = status.summary ?? {}
  return {
    total: s.total ?? 0,
    passed: s.passed ?? 0,
    failed: s.failed ?? 0,
    skipped: (s.skipped ?? 0) + (s.inconclusive ?? 0),
    failures: (status.results ?? [])
      .filter((r) => /fail|error/i.test(r.Status ?? ""))
      .map((r) => ({ name: r.FullName ?? "?", message: (r.Message ?? "").trim(), stack: (r.StackTrace ?? "").trim().split("\n").slice(0, 4).join("\n") })),
  }
}

/** Runs the project's tests through whichever route is possible right now and renders the outcome. */
export async function runTests(project: UnityProject, mode: TestMode, filter: string | undefined, editorPath: string | undefined, options: RunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 900_000

  if (await editorConnected(project.root, options)) {
    // Unity asks "save modified scenes?" before an EditMode/PlayMode run. Nobody is there to answer
    // that modal, and it freezes the Editor (and every later command) until it is dismissed.
    const scene = commandResult(await editorCommand(project.root, "get_scene_hierarchy", {}, { timeoutMs: 15_000 }))
    if (scene.ok && (scene.result as { isDirty?: boolean } | null)?.isDirty) {
      return "[unity] Tests not started: the open scene has unsaved changes, and Unity would block on a \"save scene?\" dialog. Save it first (unity_scene_edit with save: true, or ask the user to press Ctrl/Cmd+S), then run unity_test again."
    }

    // Always asynchronous: the package's synchronous mode waits on the main thread for a test
    // run that needs that same thread, and the Editor never comes back.
    const args: Record<string, unknown> = { mode: mode === "EditMode" ? "editor" : "playmode", async_tests: true, timeout: Math.floor(timeoutMs / 1000) }
    if (filter) args.filter = filter
    const started = await editorCommand(project.root, "run_tests", args, options)
    if (!started.success) return `[unity] Tests could not run in the open Editor: ${started.errors[0]?.message ?? "unknown error"}`

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      if (options.signal?.aborted) {
        await editorCommand(project.root, "cancel_tests", {}, { timeoutMs: 10_000 })
        return "[unity] Test run cancelled."
      }
      const poll = commandResult(await editorCommand(project.root, "test_status", {}, { timeoutMs: 15_000 }))
      const status = poll.ok ? (poll.result as PipelineStatus | null) : null
      if (status?.status && status.status !== "running") return renderTests(fromPipeline(status))
    }
    await editorCommand(project.root, "cancel_tests", {}, { timeoutMs: 10_000 })
    return `[unity] Tests did not finish within ${Math.round(timeoutMs / 1000)} s and were cancelled.`
  }

  if (editorHasProjectOpen(project.root)) {
    return "[unity] The Unity Editor has this project open, so tests cannot run from the command line. Ask the user to either run them in Window > General > Test Runner, install the Pipeline package (unity_pipeline_install) so the open Editor can be driven, or close the Editor."
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

// Compilation by Unity itself: the ground truth (asmdef references, scripting defines, source
// generators), at the price of a domain reload in the open Editor or a slow batch-mode start.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { editorCommand, type RunOptions, spawnCaptured } from "../unity/cli.ts"
import { findEditor, findEditorExecutable, type UnityProject } from "../unity/discovery.ts"
import { parseDiagnostics } from "./diagnostics.ts"
import type { CompileResult } from "./dotnet.ts"

const POLL_MS = 1_000

type RecompileStatus = { status?: string; errors?: string[] }

function resultObject<T>(data: unknown): T | null {
  const result = (data as { result?: unknown } | null)?.result
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as T
    } catch {
      return null
    }
  }
  return (result as T) ?? null
}

/** Asks the open Editor (Pipeline package) to recompile and waits for the verdict. */
export async function compileInOpenEditor(project: UnityProject, options: RunOptions = {}): Promise<CompileResult> {
  const started = Date.now()
  const deadline = started + (options.timeoutMs ?? 120_000)

  const trigger = await editorCommand(project.root, "recompile", {}, options)
  if (!trigger.success) return { status: "unavailable", reason: `Editor did not accept recompile: ${trigger.errors[0]?.message ?? "unknown error"}` }

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    // The domain reload after a successful compile drops the connection for a moment: keep polling.
    const poll = await editorCommand(project.root, "recompile_status", {}, { ...options, timeoutMs: 10_000 })
    const status = poll.success ? resultObject<RecompileStatus>(poll.data) : null
    if (!status || (status.status !== "completed" && status.status !== "up_to_date")) continue

    const diagnostics = parseDiagnostics((status.errors ?? []).join("\n"), project.root)
    return {
      status: diagnostics.some((d) => d.severity === "error") ? "errors" : "ok",
      diagnostics,
      unchecked: [],
      durationMs: Date.now() - started,
    }
  }
  return { status: "unavailable", reason: "the Unity Editor did not finish compiling in time" }
}

/** Opens the (closed) project in batch mode just to compile it. Slow: tens of seconds at best. */
export async function compileInBatchMode(project: UnityProject, editorPath: string | undefined, options: RunOptions = {}): Promise<CompileResult> {
  const editor = findEditor(project.version, { editorPath })
  const executable = editor ? findEditorExecutable(editor.root) : null
  if (!executable) return { status: "unavailable", reason: `Unity ${project.version} is not installed (set UNITY_EDITOR_PATH if it lives outside the Hub folder)` }

  const started = Date.now()
  const logFile = path.join(os.tmpdir(), `opencode-unity-compile-${process.pid}-${started}.log`)
  try {
    await spawnCaptured([executable, "-batchmode", "-quit", "-nographics", "-accept-apiupdate", "-projectPath", project.root, "-logFile", logFile], {
      timeoutMs: options.timeoutMs ?? 600_000,
      signal: options.signal,
    })
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""
    if (log.length === 0) return { status: "unavailable", reason: "Unity produced no log (is the license active?)" }
    const diagnostics = parseDiagnostics(log, project.root)
    return { status: diagnostics.some((d) => d.severity === "error") ? "errors" : "ok", diagnostics, unchecked: [], durationMs: Date.now() - started }
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  } finally {
    fs.rmSync(logFile, { force: true })
  }
}

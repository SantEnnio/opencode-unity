// The official Unity CLI (`unity`) drives the closed-Editor routes (tests, headless runs). An
// open Editor is reached through the Pipeline package's HTTP server directly (see pipeline.ts):
// same API the CLI uses, without paying a process start per call.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run, type RunOptions, runSync, which } from "../runtime.ts"
import { pipelineConnected, pipelineExec } from "./pipeline.ts"

export type CliJson = { success: boolean; data: unknown; errors: { code: string; message: string }[] }
export type { RunOptions }

const CLI_ENV = { UNITY_NO_BANNER: "1", UNITY_NON_INTERACTIVE: "1", UNITY_NO_PAGER: "1" }

let cachedCli: string | null | undefined

export function findUnityCli(env: Record<string, string | undefined> = process.env): string | null {
  if (cachedCli !== undefined) return cachedCli
  const exe = process.platform === "win32" ? "unity.exe" : "unity"
  const candidates = [env.UNITY_CLI_PATH, which("unity"), path.join(os.homedir(), ".unity", "bin", exe)]
  cachedCli = candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null
  return cachedCli
}

/** The CLI prints Editor logs before its JSON envelope: take the last top-level object. */
export function parseCliJson(stdout: string): CliJson | null {
  const start = stdout.lastIndexOf('{\n  "success"')
  const text = start >= 0 ? stdout.slice(start) : stdout.trim()
  try {
    const value = JSON.parse(text) as Partial<CliJson>
    return typeof value.success === "boolean" ? { success: value.success, data: value.data ?? null, errors: value.errors ?? [] } : null
  } catch {
    return null
  }
}

async function cliJson(cli: string, args: string[], options: RunOptions): Promise<CliJson> {
  // Everything after "--" belongs to the Editor command, so the CLI's own flag must come first.
  const separator = args.indexOf("--")
  const withJson = separator < 0 ? [...args, "--json"] : [...args.slice(0, separator), "--json", ...args.slice(separator)]
  const result = await run([cli, ...withJson], { ...options, env: CLI_ENV })
  return parseCliJson(result.stdout) ?? { success: false, data: null, errors: [{ code: "NO_JSON", message: (result.stderr || result.stdout).trim().slice(-400) }] }
}

/** True when an Editor with the Pipeline package has this project open and its server is up. */
export async function editorConnected(projectRoot: string, _options: RunOptions = {}): Promise<boolean> {
  return pipelineConnected(projectRoot)
}

/** Runs a Pipeline command inside the open Editor. */
export function editorCommand(projectRoot: string, name: string, args: Record<string, unknown> = {}, options: RunOptions = {}): Promise<CliJson> {
  return pipelineExec(projectRoot, name, args, options)
}

/** Unwraps a Pipeline command response: the payload sits in data.result, sometimes as JSON text. */
export function commandResult(response: CliJson): { ok: true; result: unknown } | { ok: false; error: string } {
  if (!response.success) return { ok: false, error: response.errors[0]?.message ?? "unknown error" }
  const result = (response.data as { result?: unknown } | null)?.result
  if (typeof result === "string" && /^[[{]/.test(result)) {
    try {
      return { ok: true, result: JSON.parse(result) }
    } catch {
      // plain text after all
    }
  }
  return { ok: true, result }
}

/**
 * Whether a Unity Editor currently has the project open. The lock file alone proves nothing:
 * on macOS and Linux it survives a clean exit, so what matters is whether a process holds it.
 */
export function editorHasProjectOpen(projectRoot: string): boolean {
  const lockFile = path.join(projectRoot, "Temp", "UnityLockfile")
  if (!fs.existsSync(lockFile)) return false

  if (process.platform === "win32") {
    // Unity opens it exclusively: any attempt to open it for writing fails while the Editor runs.
    try {
      fs.closeSync(fs.openSync(lockFile, "r+"))
      return false
    } catch {
      return true
    }
  }

  const lsof = which("lsof") ?? ["/usr/sbin/lsof", "/usr/bin/lsof"].find((candidate) => fs.existsSync(candidate))
  if (!lsof) return true // cannot tell: assume open, which only ever refuses work instead of corrupting a project
  return runSync([lsof, "-t", lockFile]).trim().length > 0
}

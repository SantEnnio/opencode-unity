// Wrapper around the official Unity CLI (`unity`). It is the only supported way to talk to an
// Editor that has the project open (through the Pipeline package); without it the plugin falls
// back to launching the Editor in batch mode, which only works while the project is closed.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run, type RunOptions, runSync, which } from "../runtime.ts"

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

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** True when an Editor with the Pipeline package has this project open and answers on its port. */
export async function editorConnected(projectRoot: string, options: RunOptions = {}): Promise<boolean> {
  const cli = findUnityCli()
  if (!cli) return false
  const status = await cliJson(cli, ["status"], { timeoutMs: 10_000, ...options })
  const instances = (status.data as { instances?: Record<string, unknown>[] } | null)?.instances ?? []
  return instances.some((instance) => Object.values(instance).some((v) => typeof v === "string" && samePath(v, projectRoot)))
}

/** Runs a Pipeline command inside the open Editor. Arguments are passed as --key value. */
export async function editorCommand(projectRoot: string, name: string, args: Record<string, string | number | boolean> = {}, options: RunOptions = {}): Promise<CliJson> {
  const cli = findUnityCli()
  if (!cli) return { success: false, data: null, errors: [{ code: "NO_CLI", message: "Unity CLI not installed" }] }
  const flat = Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)])
  const timeout = Math.ceil((options.timeoutMs ?? 30_000) / 1000)
  return cliJson(cli, ["command", name, "--project-path", projectRoot, "--timeout", String(timeout), ...(flat.length > 0 ? ["--", ...flat] : [])], {
    timeoutMs: (options.timeoutMs ?? 30_000) + 5_000,
    signal: options.signal,
  })
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

// opencode runs plugins on Bun in the CLI and on Node (inside Electron) in the desktop app.
// Everything here sticks to node: APIs, which both runtimes implement.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type ProcessResult = { exitCode: number; stdout: string; stderr: string }
export type RunOptions = { timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: Record<string, string> }

/** Directory of the calling module: pass `import.meta.url`. */
export const moduleDir = (metaUrl: string) => path.dirname(fileURLToPath(metaUrl))

export function which(command: string, env: Record<string, string | undefined> = process.env): string | null {
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return
  if (process.platform === "win32") {
    // MSBuild and Unity spawn workers: a plain kill would leave them holding locks.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {})
  } else {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

/** Runs a command to completion, capturing its output. Rejects when it cannot start or times out. */
export function run(command: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))

    let timedOut = false
    const timer = options.timeoutMs ? setTimeout(() => ((timedOut = true), killTree(child.pid)), options.timeoutMs) : null
    const onAbort = () => killTree(child.pid)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }

    child.on("error", (error) => {
      cleanup()
      reject(error)
    })
    child.on("close", (code) => {
      cleanup()
      if (timedOut) return reject(new Error(`${path.basename(command[0]!)} timed out after ${Math.round(options.timeoutMs! / 1000)}s`))
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
    })
  })
}

export function runSync(command: string[]): string {
  return spawnSync(command[0]!, command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).stdout ?? ""
}

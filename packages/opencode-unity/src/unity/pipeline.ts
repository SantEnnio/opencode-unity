// Direct client for the Pipeline package's local HTTP server (the same API the `unity` CLI uses).
// Starting the CLI costs seconds per call; a loopback request costs milliseconds, and scene work
// needs several calls per tool invocation.

import fs from "node:fs"
import path from "node:path"
import type { CliJson } from "./cli.ts"

type Descriptor = { pid: number; port: number; projectPath: string; evalToken: string; lastHeartbeat?: string }
type ExecEnvelope = { success?: boolean; result?: unknown; error?: string; errorDetails?: string; status?: string }

const HEARTBEAT_STALE_MS = 120_000
const BUSY_RETRIES = 20
const BUSY_DELAY_MS = 1_500

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The Editor writes this file while its server runs, and refreshes it on every heartbeat. */
export function readDescriptor(projectRoot: string): Descriptor | null {
  try {
    const descriptor = JSON.parse(fs.readFileSync(path.join(projectRoot, "Library", "Pipeline", ".unity-pipeline-port"), "utf8")) as Descriptor
    if (typeof descriptor.port !== "number" || typeof descriptor.evalToken !== "string" || !alive(descriptor.pid)) return null
    const heartbeat = descriptor.lastHeartbeat ? Date.parse(descriptor.lastHeartbeat) : Number.NaN
    // A missing or unparsable heartbeat is not proof of death; a very old one is.
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat > HEARTBEAT_STALE_MS && !alive(descriptor.pid)) return null
    return descriptor
  } catch {
    return null
  }
}

export const pipelineConnected = (projectRoot: string) => readDescriptor(projectRoot) !== null

export async function pipelineExec(
  projectRoot: string,
  command: string,
  parameters: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CliJson> {
  const failure = (code: string, message: string): CliJson => ({ success: false, data: null, errors: [{ code, message }] })

  for (let attempt = 0; ; attempt++) {
    const descriptor = readDescriptor(projectRoot)
    if (!descriptor) return failure("NOT_CONNECTED", "no Unity Editor with the Pipeline package is running for this project")

    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000)
    let response: Response
    try {
      // 127.0.0.1, not localhost: Unity's listener only serves the IPv4 loopback reliably.
      response = await fetch(`http://127.0.0.1:${descriptor.port}/api/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.evalToken}` },
        body: JSON.stringify({ command, parameters }),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      })
    } catch (error) {
      // A domain reload (after a successful compile) drops the listener for a moment.
      if (attempt < BUSY_RETRIES && !options.signal?.aborted && !timeout.aborted) {
        await new Promise((resolve) => setTimeout(resolve, BUSY_DELAY_MS))
        continue
      }
      return failure("UNREACHABLE", error instanceof Error ? error.message : String(error))
    }

    const text = await response.text()
    let envelope: ExecEnvelope
    try {
      envelope = JSON.parse(text) as ExecEnvelope
    } catch {
      return failure("BAD_RESPONSE", `HTTP ${response.status}: ${text.slice(0, 300)}`)
    }

    // 503 = the Editor is importing or compiling: documented as retryable.
    if (response.status === 503 && attempt < BUSY_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_DELAY_MS))
      continue
    }
    if (envelope.success === false || !response.ok) {
      return failure("COMMAND_FAILED", [envelope.error, envelope.errorDetails].filter(Boolean).join(": ") || `HTTP ${response.status}`)
    }
    return { success: true, data: { result: envelope.result }, errors: [] }
  }
}

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pipelineExec, pipelineState } from "../src/unity/pipeline.ts"

// A stand-in for an Editor's Pipeline server: accepts one token, answers 401 to any other.
const server = Bun.serve({
  port: 0,
  fetch: async (request) =>
    request.headers.get("authorization") === "Bearer right"
      ? Response.json({ success: true, result: { playMode: "stopped" } })
      : Response.json({ message: null, error: "Unauthorized", errorDetails: "Missing or invalid authentication token" }, { status: 401 }),
})
afterAll(() => server.stop(true))

function project(token: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-pipeline-"))
  fs.mkdirSync(path.join(root, "Library", "Pipeline"), { recursive: true })
  const descriptor = { pid: process.pid, port: server.port, projectPath: root, evalToken: token, lastHeartbeat: new Date().toISOString() }
  fs.writeFileSync(path.join(root, "Library", "Pipeline", ".unity-pipeline-port"), JSON.stringify(descriptor))
  return root
}

describe("pipeline connection", () => {
  test("this project's Editor answers", async () => {
    const root = project("right")
    expect(await pipelineState(root)).toBe("connected")
    expect((await pipelineExec(root, "editor_status")).success).toBe(true)
  })

  // Seen live: two Unity projects open, the second one's descriptor names the first one's port.
  test("another Editor on the port is reported as such, not as a failing command", async () => {
    const root = project("other")
    expect(await pipelineState(root)).toBe("port-taken")
    const result = await pipelineExec(root, "editor_status")
    expect(result.success).toBe(false)
    expect(result.errors[0]!.code).toBe("PORT_TAKEN")
    expect(result.errors[0]!.message).toContain("A different Unity project, open in a second Unity Editor")
  })

  test("no descriptor, no Editor", async () => {
    expect(await pipelineState(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-none-")))).toBe("none")
  })
})

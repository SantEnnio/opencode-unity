// Run with plain Node after `bun run build`: opencode desktop loads plugins on Node, not Bun,
// so the bundle must import and initialise there. Guards against Bun-only APIs creeping back in.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const { UnityPlugin, ...others } = await import("../dist/index.js")
if (Object.keys(others).length > 0) throw new Error(`unexpected exports: ${Object.keys(others)}`)

const client = { app: { log: async () => {} }, tui: { showToast: async () => {} } }
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-smoke-"))
const inert = await UnityPlugin({ client, directory: empty })
if (Object.keys(inert).length !== 0) throw new Error("plugin must be inert outside Unity projects")

fs.mkdirSync(path.join(empty, "ProjectSettings"))
fs.writeFileSync(path.join(empty, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1\n")
const hooks = await UnityPlugin({ client, directory: empty })
const status = await hooks.tool.unity_status.execute({}, { directory: empty, sessionID: "s", abort: new AbortController().signal })
if (!status.includes("ACTIVE")) throw new Error(`unexpected status:\n${status}`)

fs.rmSync(empty, { recursive: true, force: true })
console.log(`ok on ${typeof Bun === "undefined" ? `node ${process.version}` : "bun"}: ${Object.keys(hooks.tool).length} tools`)

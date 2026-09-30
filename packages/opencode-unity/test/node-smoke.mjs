// Run after `bun run build`, with plain Node (opencode 1 desktop loads plugins on Node) and with Bun
// (opencode 2 runs them inside its Bun binary). The bundle must import and initialise under both
// plugin APIs. Guards against Bun-only APIs and top-level package imports creeping back in.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const mod = await import("../dist/index.js")
if (Object.keys(mod).join() !== "default") throw new Error(`unexpected exports: ${Object.keys(mod)}`)
const plugin = mod.default
if (plugin.id !== "opencode-unity" || typeof plugin.server !== "function" || typeof plugin.setup !== "function") {
  throw new Error("the default export must be { id, server, setup }")
}

const empty = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-smoke-"))
const signal = new AbortController().signal

// opencode 1
const client = { app: { log: async () => {} }, tui: { showToast: async () => {} } }
if (Object.keys(await plugin.server({ client, directory: empty })).length !== 0) throw new Error("v1: plugin must be inert outside Unity projects")

// opencode 2: a stand-in context that records what the plugin registers.
const registered = { tools: new Map(), hooks: new Map(), commands: [], agents: new Map() }
const registration = { dispose: async () => {} }
const v2 = (directory) => ({
  location: { directory },
  options: {},
  tool: {
    transform: async (fn) => (fn({ add: (tool) => registered.tools.set(tool.name, tool) }), registration),
    hook: async (name, fn) => (registered.hooks.set(`tool.${name}`, fn), registration),
  },
  session: {
    hook: async (name, fn) => (registered.hooks.set(`session.${name}`, fn), registration),
    prompt: async () => {},
    synthetic: async () => {},
  },
  event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  agent: {
    transform: async (fn) => (
      fn({
        get: (id) => registered.agents.get(id),
        update: (id, update) => {
          const agent = registered.agents.get(id) ?? { id, name: "", mode: "subagent", request: { body: {} } }
          registered.agents.set(id, agent)
          update(agent)
        },
      }),
      registration
    ),
  },
  command: { transform: async (fn) => (fn({ add: (command) => registered.commands.push(command) }), registration) },
})
if ((await plugin.setup(v2(empty))) !== undefined || registered.tools.size !== 0) throw new Error("v2: plugin must be inert outside Unity projects")

fs.mkdirSync(path.join(empty, "ProjectSettings"))
fs.writeFileSync(path.join(empty, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1\n")

// opencode 1 in a Unity project
const hooks = await plugin.server({ client, directory: empty })
const status = await hooks.tool.unity_status.execute({}, { directory: empty, sessionID: "s", abort: signal })
if (!status.includes("ACTIVE")) throw new Error(`v1: unexpected status:\n${status}`)

// opencode 2 in a Unity project
const cleanup = await plugin.setup(v2(empty))
if (typeof cleanup !== "function") throw new Error("v2: setup must return a cleanup function")
const v2Status = await registered.tools.get("unity_status").execute({}, { sessionID: "s", signal })
if (!String(v2Status.content).includes("ACTIVE")) throw new Error(`v2: unexpected status:\n${JSON.stringify(v2Status)}`)
for (const [name, tool] of registered.tools) {
  if (tool.options?.codemode !== false) throw new Error(`v2: ${name} must be a native tool (codemode: false)`)
  if (tool.input?.type !== "object") throw new Error(`v2: ${name} has no JSON Schema input`)
}
const guarded = { tool: "write", sessionID: "s", input: { path: path.join(empty, "Assets", "Player.cs.meta"), content: "" } }
await registered.hooks.get("tool.execute.before")(guarded)
if (guarded.tool !== "unity_blocked") throw new Error("v2: a write to a .meta file must be blocked")
if (!registered.commands.some((c) => c.name === "unity")) throw new Error("v2: /unity command missing")
if (registered.agents.get("unity-coder")?.mode !== "primary") throw new Error("v2: unity-coder agent missing")
await cleanup()

fs.rmSync(empty, { recursive: true, force: true })
const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`
console.log(`ok on ${runtime}: v1 ${Object.keys(hooks.tool).length} tools, v2 ${registered.tools.size} tools`)

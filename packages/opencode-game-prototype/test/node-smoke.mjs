// Run after `bun run build`, with plain Node (opencode 1 desktop loads plugins on Node) and with Bun
// (opencode 2 runs them inside its Bun binary). The bundle must import and initialise under both
// plugin APIs. Guards against Bun-only APIs and top-level package imports creeping back in.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const mod = await import("../dist/index.js")
if (Object.keys(mod).join() !== "default") throw new Error(`unexpected exports: ${Object.keys(mod)}`)
const plugin = mod.default
if (plugin.id !== "opencode-game-prototype" || typeof plugin.server !== "function" || typeof plugin.setup !== "function") {
  throw new Error("the default export must be { id, server, setup }")
}

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-smoke-")))
const signal = new AbortController().signal
// No browser here: the smoke test is about loading and registering, on any machine.
const options = { checkOnEdit: false, port: 0 }

// opencode 1
const client = { app: { log: async () => {} } }
const hooks = await plugin.server({ client, directory: dir }, options)
const status = await hooks.tool.proto_status.execute({}, { directory: dir, sessionID: "s", abort: signal })
if (!status.includes("ACTIVE") || !status.includes("three.js: r")) throw new Error(`v1: unexpected status:\n${status}`)
const created = await hooks.tool.proto_new.execute({ name: "Smoke Test" }, { directory: dir, sessionID: "s", abort: signal })
if (!created.includes('Created "smoke-test"')) throw new Error(`v1: proto_new failed:\n${created}`)
for (const file of ["index.html", "main.js", "vendor/kit.js", "vendor/three.module.js", "vendor/three.core.js"]) {
  if (!fs.existsSync(path.join(dir, "smoke-test", file))) throw new Error(`v1: the new prototype has no ${file}`)
}
const config = {}
await hooks.config(config)
if (config.agent?.["game-prototyper"]?.mode !== "primary" || !config.command?.prototype) throw new Error("v1: agent or command missing")
let refused = ""
await hooks["tool.execute.before"]({ tool: "write", sessionID: "s" }, { args: { filePath: path.join(dir, "smoke-test", "vendor", "kit.js") } }).catch((error) => (refused = error.message))
if (!refused.includes("Blocked")) throw new Error("v1: a write to vendor/ must be blocked")

// opencode 2: a stand-in context that records what the plugin registers.
const registered = { tools: new Map(), hooks: new Map(), commands: [], agents: new Map() }
const registration = { dispose: async () => {} }
const cleanup = await plugin.setup({
  location: { directory: dir },
  options,
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
if (typeof cleanup !== "function") throw new Error("v2: setup must return a cleanup function")
const v2Status = await registered.tools.get("proto_status").execute({}, { sessionID: "s", signal })
if (!String(v2Status.content).includes("- smoke-test: http://127.0.0.1:")) throw new Error(`v2: unexpected status:\n${JSON.stringify(v2Status)}`)
for (const [name, tool] of registered.tools) {
  if (tool.options?.codemode !== false) throw new Error(`v2: ${name} must be a native tool (codemode: false)`)
  if (tool.input?.type !== "object") throw new Error(`v2: ${name} has no JSON Schema input`)
}
const guarded = { tool: "write", sessionID: "s", input: { path: path.join(dir, "smoke-test", "vendor", "kit.js"), content: "" } }
await registered.hooks.get("tool.execute.before")(guarded)
if (guarded.tool !== "proto_blocked") throw new Error("v2: a write to vendor/ must be blocked")
const context = { sessionID: "s", agent: "game-prototyper", system: [] }
await registered.hooks.get("session.context")(context)
if (!context.system[0]?.text.includes("# Game prototype")) throw new Error("v2: the rules did not reach the prototyper agent")
if (!registered.commands.some((c) => c.name === "prototype")) throw new Error("v2: /prototype command missing")
if (registered.agents.get("game-prototyper")?.mode !== "primary") throw new Error("v2: game-prototyper agent missing")

// The local server answers on this runtime's node:http, with the probe in the page.
const address = /http:\/\/127\.0\.0\.1:\d+\/smoke-test\//.exec(String(v2Status.content))[0]
const page = await (await fetch(address)).text()
if (!page.includes("/__proto/probe.js")) throw new Error("the served page has no probe")
const three = await fetch(`${address}vendor/three.module.js`)
if (three.status !== 200 || !three.headers.get("content-type").startsWith("text/javascript")) throw new Error("three.js is not served as a script")
await cleanup()

fs.rmSync(dir, { recursive: true, force: true })
const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`
console.log(`ok on ${runtime}: v1 ${Object.keys(hooks.tool).length} tools, v2 ${registered.tools.size} tools`)

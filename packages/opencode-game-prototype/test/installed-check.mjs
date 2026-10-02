// Checks an installed copy of the plugin, the way opencode 2 loads it: imports the plugin file from
// the config directory, creates a prototype and, unless PROTO_SKIP_LIVE=1, plays it in a browser.
// Through `setup`, not `server`: opencode 1's entry needs @opencode-ai/plugin, which opencode 1
// itself puts in the config directory and a fresh machine does not have.
//
//   node test/installed-check.mjs <path to plugins/opencode-game-prototype.js>
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const plugin = (await import(pathToFileURL(path.resolve(process.argv[2])).href)).default
if (plugin.id !== "opencode-game-prototype" || typeof plugin.setup !== "function" || typeof plugin.server !== "function") throw new Error("bad plugin export")

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-installed-")))
const tools = new Map()
const registration = { dispose: async () => {} }
const cleanup = await plugin.setup({
  location: { directory: dir },
  options: { port: 0 },
  tool: { transform: async (fn) => (fn({ add: (tool) => tools.set(tool.name, tool) }), registration), hook: async () => registration },
  session: { hook: async () => registration, prompt: async () => {}, synthetic: async () => {} },
  event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  agent: { transform: async () => registration },
  command: { transform: async () => registration },
})
if (typeof cleanup !== "function") throw new Error("the plugin is off: its assets were not found next to it")
const call = async (name, input) => String((await tools.get(name).execute(input, { sessionID: "s", signal: new AbortController().signal })).content)

const created = await call("proto_new", { name: "installed" })
if (!created.includes('Created "installed"')) throw new Error(`proto_new failed:\n${created}`)
console.log((await call("proto_status", {})).split("\n").slice(0, 4).join("\n"))

if (process.env.PROTO_SKIP_LIVE !== "1") {
  const report = await call("proto_play", { keys: "D 1s" })
  console.log(report)
  if (!report.includes("No errors.") || !report.includes("Player moved") || !report.includes('"Score 0" → "Score 1"')) throw new Error("the test play did not show the player reaching the coin")
}
await cleanup()
console.log("installed plugin works")
process.exit(0)

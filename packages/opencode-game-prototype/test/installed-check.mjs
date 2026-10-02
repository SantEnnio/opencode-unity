// Checks an installed copy of the plugin, the way opencode loads it: imports the plugin file from
// the config directory, creates a prototype and, unless PROTO_SKIP_LIVE=1, plays it in a browser.
//
//   node test/installed-check.mjs <path to plugins/opencode-game-prototype.js>
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const plugin = (await import(pathToFileURL(path.resolve(process.argv[2])).href)).default
if (plugin.id !== "opencode-game-prototype" || typeof plugin.setup !== "function" || typeof plugin.server !== "function") throw new Error("bad plugin export")

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-installed-")))
const hooks = await plugin.server({ client: { app: { log: async () => {} } }, directory: dir }, { port: 0 })
if (!hooks.tool) throw new Error("the plugin is off: its assets were not found next to it")
const context = { directory: dir, sessionID: "s", abort: new AbortController().signal }

const created = await hooks.tool.proto_new.execute({ name: "installed" }, context)
if (!created.includes('Created "installed"')) throw new Error(`proto_new failed:\n${created}`)
console.log((await hooks.tool.proto_status.execute({}, context)).split("\n").slice(0, 4).join("\n"))

if (process.env.PROTO_SKIP_LIVE !== "1") {
  const report = await hooks.tool.proto_play.execute({ keys: "D 1s" }, context)
  console.log(report)
  if (!report.includes("No errors.") || !report.includes("Player moved") || !report.includes('"Score 0" → "Score 1"')) throw new Error("the test play did not show the player reaching the coin")
}
console.log("installed plugin works")
process.exit(0)

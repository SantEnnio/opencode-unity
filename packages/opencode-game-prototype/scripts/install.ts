// Installs the plugin into opencode's global config directory, so it is there in every folder
// opened with opencode (CLI or desktop).
//
//   bun run scripts/install.ts              install or update
//   bun run scripts/install.ts --uninstall  remove

import fs from "node:fs"
import path from "node:path"
import { configDir } from "../../opencode-unity/src/options.ts"
import { packageRoot, prepareAssets } from "./assets.ts"
import { bundle } from "./bundle.ts"

const target = configDir()
const pluginFile = path.join(target, "plugins", "opencode-game-prototype.js")
const assetsDir = path.join(target, "opencode-game-prototype")

if (process.argv.includes("--uninstall")) {
  fs.rmSync(pluginFile, { force: true })
  fs.rmSync(path.join(assetsDir, "assets"), { recursive: true, force: true })
  fs.rmSync(path.join(assetsDir, "VERSION"), { force: true })
  console.log(`Removed opencode-game-prototype from ${target} (config.json was left in place).`)
  process.exit(0)
}

prepareAssets()
await bundle("src/index.ts", pluginFile)
fs.rmSync(path.join(assetsDir, "assets"), { recursive: true, force: true })
fs.cpSync(path.join(packageRoot, "assets"), path.join(assetsDir, "assets"), { recursive: true })

const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version
fs.writeFileSync(path.join(assetsDir, "VERSION"), `${version}\n`)

console.log(`opencode-game-prototype ${version} installed:`)
console.log(`  plugin   ${pluginFile}`)
console.log(`  assets   ${assetsDir}`)
console.log(`  options  ${path.join(assetsDir, "config.json")} (optional), or .opencode/game-prototype.json per project`)
console.log("\nRestart opencode to load it.")

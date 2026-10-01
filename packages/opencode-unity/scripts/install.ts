// Installs the plugin into opencode's global config directory, so it is active in every Unity
// project opened with opencode (CLI or desktop) and inert everywhere else.
//
//   bun run scripts/install.ts              install or update
//   bun run scripts/install.ts --uninstall  remove (caches are kept)

import fs from "node:fs"
import path from "node:path"
import { configDir } from "../src/options.ts"
import { bundle } from "./bundle.ts"

const packageRoot = path.join(import.meta.dir, "..")
const target = configDir()
const pluginFile = path.join(target, "plugins", "opencode-unity.js")
const assetsDir = path.join(target, "opencode-unity")

if (process.argv.includes("--uninstall")) {
  fs.rmSync(pluginFile, { force: true })
  fs.rmSync(path.join(assetsDir, "symbol-exporter"), { recursive: true, force: true })
  fs.rmSync(path.join(assetsDir, "cli.js"), { force: true })
  fs.rmSync(path.join(assetsDir, "unity-probe"), { recursive: true, force: true })
  console.log(`Removed opencode-unity from ${target} (config.json and caches were left in place).`)
  process.exit(0)
}

const exporter = path.join(packageRoot, "bin", "symbol-exporter")
if (!fs.existsSync(path.join(exporter, "symbol-exporter.dll"))) {
  console.log("Building the symbol exporter (needs the .NET SDK)...")
  const build = Bun.spawnSync(["dotnet", "publish", path.join(packageRoot, "..", "..", "tools", "symbol-exporter"), "-c", "Release", "-o", exporter, "--nologo", "-v", "q"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if (build.exitCode !== 0) throw new Error("dotnet publish failed: is the .NET SDK installed?")
}

await bundle("src/index.ts", pluginFile)
await bundle("src/cli.ts", path.join(assetsDir, "cli.js"))
fs.rmSync(path.join(assetsDir, "symbol-exporter"), { recursive: true, force: true })
fs.cpSync(exporter, path.join(assetsDir, "symbol-exporter"), { recursive: true })
fs.rmSync(path.join(assetsDir, "unity-probe"), { recursive: true, force: true })
fs.cpSync(path.join(packageRoot, "unity-probe"), path.join(assetsDir, "unity-probe"), { recursive: true })

const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version
fs.writeFileSync(path.join(assetsDir, "VERSION"), `${version}\n`)

console.log(`opencode-unity ${version} installed:`)
console.log(`  plugin   ${pluginFile}`)
console.log(`  assets   ${assetsDir}`)
console.log(`  options  ${path.join(assetsDir, "config.json")} (optional), or .opencode/unity.json per project`)
if (!fs.existsSync(path.join(target, "node_modules", "@opencode-ai", "plugin"))) {
  console.log("\nNote: @opencode-ai/plugin is not in the config directory yet. opencode installs it on its next start.")
}
console.log("\nRestart opencode to load it.")

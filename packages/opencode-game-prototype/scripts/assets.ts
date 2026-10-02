// three.js travels with the plugin: classroom machines get it from the install, not from the network.
// Copied out of node_modules into assets/three (not committed), which the bundle, the npm package
// and the global install all ship.

import fs from "node:fs"
import path from "node:path"

export const packageRoot = path.join(import.meta.dir, "..")

export function prepareAssets() {
  const source = path.join(packageRoot, "node_modules", "three")
  const target = path.join(packageRoot, "assets", "three")
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const file of ["three.module.js", "three.core.js"]) fs.copyFileSync(path.join(source, "build", file), path.join(target, file))
  fs.copyFileSync(path.join(source, "LICENSE"), path.join(target, "LICENSE"))
  const { version } = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")) as { version: string }
  fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify({ name: "three", version }, null, 2)}\n`)
  return version
}

if (import.meta.main) console.log(`assets/three: three.js ${prepareAssets()}`)

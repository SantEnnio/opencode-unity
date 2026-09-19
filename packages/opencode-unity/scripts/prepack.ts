// Runs before `npm pack` / `npm publish`: the tarball must contain the bundles, the prebuilt exporter and the README.

import fs from "node:fs"
import path from "node:path"
import { bundle } from "./bundle.ts"

const packageRoot = path.join(import.meta.dir, "..")
const build = Bun.spawnSync(
  ["dotnet", "publish", path.join(packageRoot, "..", "..", "tools", "symbol-exporter"), "-c", "Release", "-o", path.join(packageRoot, "bin", "symbol-exporter"), "--nologo", "-v", "q"],
  { stdout: "inherit", stderr: "inherit" },
)
if (build.exitCode !== 0) throw new Error("dotnet publish failed")
await bundle("src/index.ts", path.join(packageRoot, "dist", "index.js"))
await bundle("src/cli.ts", path.join(packageRoot, "dist", "cli.js"))
fs.copyFileSync(path.join(packageRoot, "..", "..", "README.md"), path.join(packageRoot, "README.md"))

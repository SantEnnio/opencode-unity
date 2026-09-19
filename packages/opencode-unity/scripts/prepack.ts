// Runs before `npm pack` / `npm publish`: the tarball must contain the prebuilt exporter and the README.

import fs from "node:fs"
import path from "node:path"

const packageRoot = path.join(import.meta.dir, "..")
const build = Bun.spawnSync(
  ["dotnet", "publish", path.join(packageRoot, "..", "..", "tools", "symbol-exporter"), "-c", "Release", "-o", path.join(packageRoot, "bin", "symbol-exporter"), "--nologo", "-v", "q"],
  { stdout: "inherit", stderr: "inherit" },
)
if (build.exitCode !== 0) throw new Error("dotnet publish failed")
fs.copyFileSync(path.join(packageRoot, "..", "..", "README.md"), path.join(packageRoot, "README.md"))

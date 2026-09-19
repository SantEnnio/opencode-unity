import fs from "node:fs"
import path from "node:path"

export const packageRoot = path.join(import.meta.dir, "..")

/** One self-contained ES module that runs on Node (opencode desktop) and on Bun (opencode CLI). */
export async function bundle(entry: string, outFile: string) {
  const result = await Bun.build({
    entrypoints: [path.join(packageRoot, entry)],
    target: "node",
    format: "esm",
    // @opencode-ai/plugin is resolved from opencode's own install so tool schemas share its zod instance.
    external: ["@opencode-ai/plugin", "bun:sqlite", "node:sqlite"],
  })
  if (!result.success) throw new AggregateError(result.logs, `bundling ${entry} failed`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  await Bun.write(outFile, await result.outputs[0]!.text())
}

if (import.meta.main) {
  await bundle("src/index.ts", path.join(packageRoot, "dist", "index.js"))
  await bundle("src/cli.ts", path.join(packageRoot, "dist", "cli.js"))
  console.log("built dist/index.js and dist/cli.js")
}

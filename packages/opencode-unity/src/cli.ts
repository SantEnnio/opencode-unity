#!/usr/bin/env bun
// Maintenance commands for things too heavy to start from inside a chat session.
//   opencode-unity docs install [unityVersion|projectPath] [--keep-zip]
//   opencode-unity docs status  [unityVersion|projectPath]

import { docsDbPath, docsInstalled, docsUrl, docsStream, installDocs } from "./docs/install.ts"
import { docsMeta } from "./docs/store.ts"
import { loadProject } from "./unity/discovery.ts"

function resolveVersion(arg: string | undefined): string {
  if (arg && /^\d+\.\d+/.test(arg)) return arg
  const project = loadProject(arg ?? process.cwd())
  if (!project) throw new Error("pass a Unity version (e.g. 6000.0) or run this inside a Unity project")
  return project.version
}

async function main(argv: string[]): Promise<number> {
  const [area, action, ...rest] = argv
  const flags = new Set(rest.filter((a) => a.startsWith("--")))
  const positional = rest.find((a) => !a.startsWith("--"))

  if (area === "docs" && action === "install") {
    const version = resolveVersion(positional)
    console.log(`Unity ${docsStream(version)} documentation <- ${docsUrl(docsStream(version))}`)
    const pages = await installDocs(version, (message) => console.log(`  ${message}`), flags.has("--keep-zip"))
    console.log(`Indexed ${pages} pages into ${docsDbPath(version)}`)
    return 0
  }
  if (area === "docs" && action === "status") {
    const version = resolveVersion(positional)
    const file = docsDbPath(version)
    console.log(docsInstalled(version) ? `installed: ${docsMeta(file, "pages")} pages in ${file}` : `not installed (${file})`)
    return 0
  }

  console.error("usage: opencode-unity docs <install|status> [unityVersion|projectPath] [--keep-zip]")
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)

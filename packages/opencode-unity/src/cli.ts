#!/usr/bin/env node
// Maintenance commands for things too heavy to start from inside a chat session.
//   opencode-unity docs index  [projectPath]
//   opencode-unity docs status [projectPath]
//   opencode-unity probe <install|uninstall|status> [projectPath]

import { docsDbPath, docsReady, editorDocsDir, ensureEditorDocs } from "./docs/editor.ts"
import { docsMeta } from "./docs/store.ts"
import { installedProbe, installProbe, PROBE_VERSION, uninstallProbe } from "./probe/package.ts"
import { findEditor, loadProject } from "./unity/discovery.ts"

/** The project's Unity version and the Documentation module of its Editor. */
function editorDocs(projectArg: string | undefined) {
  const project = loadProject(projectArg ?? process.cwd())
  if (!project) throw new Error("pass a Unity project path, or run this inside a Unity project")
  const editor = findEditor(project.version)
  if (!editor) throw new Error(`Unity ${project.version} is not installed`)
  const dir = editorDocsDir(editor.root)
  if (!dir) throw new Error(`Unity ${project.version} has no Documentation module. Add it in Unity Hub: Installs, the menu of Unity ${project.version}, Add modules, Documentation.`)
  return { version: project.version, dir }
}

async function main(argv: string[]): Promise<number> {
  const [area, action, ...rest] = argv
  const positional = rest.find((a) => !a.startsWith("--"))

  if (area === "docs" && action === "index") {
    const { version, dir } = editorDocs(positional)
    console.log(`Unity ${version} documentation <- ${dir}`)
    const pages = await ensureEditorDocs(version, dir, (message) => console.log(`  ${message}`))
    console.log(`${pages} pages in ${docsDbPath(version)}`)
    return 0
  }
  if (area === "docs" && action === "status") {
    const { version, dir } = editorDocs(positional)
    console.log(docsReady(version, dir) ? `ready: ${docsMeta(docsDbPath(version), "pages")} pages from ${dir}` : `not indexed yet (${dir})`)
    return 0
  }

  if (area === "probe") {
    const project = loadProject(positional ?? process.cwd())
    if (!project) throw new Error("pass a Unity project path, or run this inside a Unity project")
    if (action === "install") {
      console.log(`Runtime probe ${PROBE_VERSION} copied to ${installProbe(project.root)}. Unity imports it when its window gets focus.`)
      return 0
    }
    if (action === "uninstall") {
      console.log(uninstallProbe(project.root) ? "Runtime probe removed." : "The runtime probe was not installed.")
      return 0
    }
    if (action === "status") {
      const version = installedProbe(project.root)
      console.log(version ? `installed: ${version} (plugin ships ${PROBE_VERSION})` : "not installed")
      return 0
    }
  }

  console.error("usage: opencode-unity docs <index|status> [projectPath]\n       opencode-unity probe <install|uninstall|status> [projectPath]")
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)

// What the plugin sees and which route each feature will take. Exists because a plugin that works
// silently is indistinguishable from one that never loaded.

import fs from "node:fs"
import path from "node:path"
import pkg from "../package.json" with { type: "json" }
import { listProjectFiles } from "./compile/reconcile.ts"
import { docsDbPath, docsInstalled, docsInstalling, docsStream } from "./docs/install.ts"
import { docsMeta } from "./docs/store.ts"
import type { UnityPluginOptions } from "./options.ts"
import { projectFacts } from "./rules.ts"
import { which } from "./runtime.ts"
import { editorConnected, editorHasProjectOpen, findUnityCli } from "./unity/cli.ts"
import { cacheDir, findEditor, type UnityProject } from "./unity/discovery.ts"

export const VERSION: string = pkg.version

export const startupLine = (project: UnityProject) => `opencode-unity ${VERSION} active: Unity ${project.version} project at ${project.root}`

export async function renderStatus(project: UnityProject, options: UnityPluginOptions, signal?: AbortSignal): Promise<string> {
  const facts = projectFacts(project)
  const editor = findEditor(project.version, { editorPath: options.editorPath })
  const dotnet = which("dotnet")
  const projects = listProjectFiles(project.root).length
  const open = editorHasProjectOpen(project.root)
  const connected = await editorConnected(project.root, { signal })
  const symbols = path.join(cacheDir(), "symbols", `${project.version}.db`)

  const onEdit =
    options.compileOnEdit === false
      ? "off (compileOnEdit=false)"
      : !dotnet && !connected
        ? "UNAVAILABLE: install the .NET SDK"
        : projects > 0 && dotnet
          ? `dotnet build (${projects} generated .csproj)`
          : connected
            ? "Unity Editor recompile (Pipeline)"
            : "UNAVAILABLE: no .csproj yet. In Unity: Preferences > External Tools, pick an editor, Regenerate project files"

  const docs = docsInstalled(project.version)
    ? `installed (${docsMeta(docsDbPath(project.version), "pages")} pages)`
    : docsInstalling(project.version)
      ? "downloading / indexing"
      : "not installed (unity_docs_install)"

  let pipelinePackage = false
  try {
    pipelinePackage = "com.unity.pipeline" in (JSON.parse(fs.readFileSync(path.join(project.root, "Packages", "manifest.json"), "utf8")).dependencies ?? {})
  } catch {
    // no manifest: treat as not installed
  }
  const pipeline = connected
    ? "connected"
    : pipelinePackage
      ? open
        ? "installed, but its server is not answering (in Unity: Pipeline > Start Server)"
        : "installed; open the project in Unity to use it"
      : "NOT INSTALLED. It enables scene editing, the Console, tests and Unity's own compiler in the open Editor. If the user wants them, call unity_pipeline_install (they will be asked to approve)."

  const yes = (value: boolean) => (value ? "yes" : "no")
  return [
    `opencode-unity ${VERSION}: ACTIVE`,
    "",
    `Project          ${project.root}`,
    `Unity            ${project.version}, ${facts.renderPipeline}, input handler ${facts.inputHandler ?? "unknown"}${facts.packages.length > 0 ? `, packages: ${facts.packages.join(", ")}` : ""}`,
    `Editor install   ${editor ? editor.root : "NOT FOUND (set UNITY_EDITOR_PATH): API hints are limited to the project packages"}`,
    `.NET SDK         ${dotnet ?? "NOT FOUND: no compile check, no API index"}`,
    `API index        ${fs.existsSync(symbols) ? "ready" : "not built yet (built on first use)"}`,
    `Documentation    ${docsStream(project.version)}: ${docs}`,
    `Unity CLI        ${findUnityCli() ?? "not installed"}`,
    `Editor open      ${yes(open)}`,
    `Pipeline package ${pipeline}`,
    "",
    `Compile on edit  ${onEdit}`,
    `unity_compile    ${connected ? "Unity Editor recompile (Pipeline)" : projects > 0 && dotnet ? "dotnet build" : open ? "UNAVAILABLE while the Editor is open without the Pipeline package" : "Unity batch mode"}`,
    `unity_test       ${connected ? "in the open Editor (Pipeline)" : open ? "UNAVAILABLE while the Editor is open without the Pipeline package" : "Unity CLI / batch mode"}`,
    `unity_console    ${connected ? "available" : "needs the Pipeline package in an open Editor"}`,
    `Scene editing    ${connected ? "available (unity_scene_view, unity_scene_edit)" : "needs the Pipeline package in an open Editor"}`,
    `Lints ${options.lint === false ? "off" : "on"}, guards on${options.allow?.length ? ` (allowed: ${options.allow.join(", ")})` : ""}, idle gate ${options.idleGate === false ? "off" : "on"}, rules ${options.rules === false ? "off" : "on"}`,
  ].join("\n")
}

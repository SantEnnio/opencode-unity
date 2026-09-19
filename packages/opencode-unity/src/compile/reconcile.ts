// Unity's generated .csproj files list every source file explicitly, and they are only
// regenerated when the Editor refreshes. Scripts the model has just created (or deleted)
// would be invisible to `dotnet build`, so the difference is injected through an extra
// MSBuild targets file instead of touching the generated projects.

import fs from "node:fs"
import path from "node:path"

export type ProjectFile = {
  path: string
  assemblyName: string
  sources: Set<string>
  references: string[]
}

export type Reconciliation = {
  /** absolute source path -> assembly name */
  added: Map<string, string>
  /** absolute source path -> assembly name */
  removed: Map<string, string>
  /** new scripts whose assembly has no generated project yet */
  unchecked: string[]
}

const SCRIPT_ROOTS = ["Assets", "Packages"]

const attr = (xml: string, tag: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${tag}\\s[^>]*${name}="([^"]+)"`, "g"))].map((m) => m[1]!)

const normalize = (file: string) => path.resolve(file)

export function readProjectFile(file: string): ProjectFile {
  const xml = fs.readFileSync(file, "utf8")
  const dir = path.dirname(file)
  const fromProject = (p: string) => normalize(path.join(dir, p.replaceAll("\\", path.sep)))
  return {
    path: file,
    assemblyName: /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(xml)?.[1] ?? path.basename(file, ".csproj"),
    sources: new Set(attr(xml, "Compile", "Include").map(fromProject)),
    references: attr(xml, "ProjectReference", "Include").map(fromProject),
  }
}

export function listProjectFiles(projectRoot: string): ProjectFile[] {
  return fs
    .readdirSync(projectRoot)
    .filter((f) => f.toLowerCase().endsWith(".csproj"))
    .sort()
    .map((f) => readProjectFile(path.join(projectRoot, f)))
}

/** Projects nobody references: building these builds everything else through ProjectReference. */
export function buildEntryPoints(projects: ProjectFile[]): ProjectFile[] {
  const referenced = new Set(projects.flatMap((p) => p.references))
  const roots = projects.filter((p) => !referenced.has(normalize(p.path)))
  return roots.length > 0 ? roots : projects
}

export function* walkScripts(dir: string): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // Unity ignores hidden entries and folders ending with "~"
    if (entry.name.startsWith(".") || entry.name.endsWith("~")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkScripts(full)
    else if (entry.name.toLowerCase().endsWith(".cs")) yield normalize(full)
  }
}

function asmdefName(dir: string): string | null {
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return null
  }
  const asmdef = files.find((f) => f.toLowerCase().endsWith(".asmdef"))
  if (!asmdef) return null
  try {
    const name: unknown = JSON.parse(fs.readFileSync(path.join(dir, asmdef), "utf8")).name
    return typeof name === "string" ? name : null
  } catch {
    return null
  }
}

/** Mirrors Unity's rules: nearest .asmdef wins, otherwise one of the four predefined assemblies. */
export function assemblyFor(scriptPath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, scriptPath).split(path.sep)
  for (let depth = relative.length - 1; depth >= 1; depth--) {
    const name = asmdefName(path.join(projectRoot, ...relative.slice(0, depth)))
    if (name) return name
  }

  const folders = relative.slice(0, -1).map((f) => f.toLowerCase())
  const firstPass =
    folders[1] === "plugins" || folders[1] === "standard assets" || folders[1] === "pro standard assets"
  const editor = folders.includes("editor")
  return `Assembly-CSharp${editor ? "-Editor" : ""}${firstPass ? "-firstpass" : ""}`
}

export function reconcile(projectRoot: string, projects: ProjectFile[]): Reconciliation {
  const result: Reconciliation = { added: new Map(), removed: new Map(), unchecked: [] }
  const assemblies = new Set(projects.map((p) => p.assemblyName))
  const known = new Set(projects.flatMap((p) => [...p.sources]))

  for (const root of SCRIPT_ROOTS) {
    for (const script of walkScripts(path.join(projectRoot, root))) {
      if (known.has(script)) continue
      const assembly = assemblyFor(script, projectRoot)
      if (assemblies.has(assembly)) result.added.set(script, assembly)
      else if (root === "Assets") result.unchecked.push(script)
    }
  }

  for (const project of projects) {
    for (const source of project.sources) {
      if (!fs.existsSync(source)) result.removed.set(source, project.assemblyName)
    }
  }
  return result
}

const escapeXml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export function renderTargets(reconciliation: Reconciliation): string {
  const byAssembly = new Map<string, string[]>()
  const push = (assembly: string, item: string) => byAssembly.set(assembly, [...(byAssembly.get(assembly) ?? []), item])
  for (const [file, assembly] of reconciliation.removed) push(assembly, `<Compile Remove="${escapeXml(file)}" />`)
  for (const [file, assembly] of reconciliation.added) push(assembly, `<Compile Include="${escapeXml(file)}" />`)

  const groups = [...byAssembly].map(
    ([assembly, items]) =>
      `  <ItemGroup Condition="'$(AssemblyName)' == '${escapeXml(assembly)}'">\n${items.map((i) => `    ${i}`).join("\n")}\n  </ItemGroup>`,
  )
  return `<Project>\n${groups.join("\n")}\n</Project>\n`
}

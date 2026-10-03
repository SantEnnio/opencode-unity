// Where prototypes live. Inside a Unity or Unreal project they go in .prototypes/ at its root, out
// of the engine's way; anywhere else, in the folder opencode was started in.

import fs from "node:fs"
import path from "node:path"
import { moduleDir } from "../../opencode-unity/src/runtime.ts"

export type Engine = "Unity" | "Unreal"
export type Place = { root: string; engine: Engine | null }
export type Prototype = { name: string; dir: string }

function engineAt(dir: string): Engine | null {
  if (fs.existsSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"))) return "Unity"
  try {
    if (fs.readdirSync(dir).some((entry) => entry.endsWith(".uproject"))) return "Unreal"
  } catch {
    // unreadable: not an engine project as far as we can tell
  }
  return null
}

/** The engine project `directory` is in (itself or a folder above it), if any. */
export function place(directory: string): Place {
  let dir = path.resolve(directory)
  for (let depth = 0; depth < 8; depth++) {
    const engine = engineAt(dir)
    if (engine) return { root: path.join(dir, ".prototypes"), engine }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { root: path.resolve(directory), engine: null }
}

const isPrototype = (dir: string) => fs.existsSync(path.join(dir, "index.html")) && fs.existsSync(path.join(dir, "vendor", "kit.js"))

export function listPrototypes(root: string): Prototype[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && isPrototype(path.join(root, entry.name)))
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The prototype a file belongs to, and the file's path inside it with forward slashes. */
export function prototypeOf(root: string, file: string): { prototype: Prototype; inside: string } | null {
  const relative = path.relative(root, path.resolve(file))
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null
  const [name, ...rest] = relative.split(path.sep)
  if (!name || rest.length === 0) return null
  const dir = path.join(root, name)
  return isPrototype(dir) ? { prototype: { name, dir }, inside: rest.join("/") } : null
}

/** A folder name from what the model wrote: "Double Jump" -> "double-jump". Null when nothing usable is left. */
export function cleanName(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  return name.length > 0 ? name : null
}

// From source: src -> <package>/assets. npm package: dist -> <package>/assets. Global install:
// the bundle sits in <config>/plugins, its assets in <config>/opencode-game-prototype.
const here = moduleDir(import.meta.url)
const ASSET_CANDIDATES = [path.join(here, "..", "assets"), path.join(here, "..", "opencode-game-prototype", "assets")]

export const assetsDir = () => ASSET_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, "probe.js"))) ?? null

const THREE_FILES = ["three.module.js", "three.core.js"]

/** three.js as shipped with the plugin; from node_modules when running from source. */
export function threeSource(assets: string): { dir: string; version: string } | null {
  for (const [dir, manifest] of [
    [path.join(assets, "three"), path.join(assets, "three", "package.json")],
    [path.join(assets, "..", "node_modules", "three", "build"), path.join(assets, "..", "node_modules", "three", "package.json")],
  ] as const) {
    if (!THREE_FILES.every((file) => fs.existsSync(path.join(dir, file)))) continue
    try {
      return { dir, version: (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version }
    } catch {
      // a build without its manifest: look further
    }
  }
  return null
}

/** "0.186.1" -> "r186", the name three.js itself uses. */
export const revision = (version: string) => `r${version.split(".")[1] ?? version}`

/** Copies the template and three.js into a new folder. Throws when the plugin's own files are missing. */
export function createPrototype(root: string, name: string): Prototype {
  const assets = assetsDir()
  const three = assets ? threeSource(assets) : null
  if (!assets || !three) throw new Error("the template or three.js is missing from this opencode-game-prototype install")
  const dir = path.join(root, name)
  fs.mkdirSync(root, { recursive: true })
  fs.cpSync(path.join(assets, "template"), dir, { recursive: true })
  for (const file of ["index.html", "PLAN.md"]) {
    const target = path.join(dir, file)
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("__NAME__", name))
  }
  for (const file of THREE_FILES) fs.copyFileSync(path.join(three.dir, file), path.join(dir, "vendor", file))
  const license = [path.join(three.dir, "LICENSE"), path.join(three.dir, "..", "LICENSE")].find((file) => fs.existsSync(file))
  if (license) fs.copyFileSync(license, path.join(dir, "vendor", "three.LICENSE"))
  return { name, dir }
}

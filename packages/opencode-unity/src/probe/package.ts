// The optional runtime probe: a Unity package shipped inside the plugin and copied into the
// project as an embedded package. Not a git URL: Unity resolves git dependencies only when git is
// installed, and classroom machines may not have it.

import fs from "node:fs"
import path from "node:path"
import probePackage from "../../unity-probe/package.json" with { type: "json" }
import { moduleDir } from "../runtime.ts"
import { probeDir } from "./report.ts"

export const PROBE_NAME = probePackage.name
export const PROBE_VERSION: string = probePackage.version

// From source: src/probe -> <package>/unity-probe. npm package: dist -> <package>/unity-probe.
// Global install: the bundle sits in <config>/plugins, its assets in <config>/opencode-unity.
const here = moduleDir(import.meta.url)
const SOURCE_CANDIDATES = [
  path.join(here, "..", "..", "unity-probe"),
  path.join(here, "..", "unity-probe"),
  path.join(here, "..", "opencode-unity", "unity-probe"),
]

export const probeSource = () => SOURCE_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, "package.json"))) ?? null

const installedDir = (projectRoot: string) => path.join(projectRoot, "Packages", PROBE_NAME)

/** The probe version in the project, or null when it is not installed. */
export function installedProbe(projectRoot: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(installedDir(projectRoot), "package.json"), "utf8")) as { version?: string }).version ?? "?"
  } catch {
    return null
  }
}

export type ProbeState = "missing" | "outdated" | "current"
export function probeState(projectRoot: string): ProbeState {
  const version = installedProbe(projectRoot)
  return version === null ? "missing" : version === PROBE_VERSION ? "current" : "outdated"
}

/** Copies the probe into Packages/, replacing an older copy. The .meta files are Unity's to create. */
export function installProbe(projectRoot: string): string {
  const source = probeSource()
  if (!source) throw new Error("the probe package is missing from this opencode-unity install")
  const target = installedDir(projectRoot)
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true, filter: (file) => !file.endsWith(".meta") })
  return target
}

export function uninstallProbe(projectRoot: string): boolean {
  const target = installedDir(projectRoot)
  if (!fs.existsSync(target)) return false
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

const MAX_WATCHED = 30

/** Objects the model created or changed: the probe records them first when the game plays. */
export function rememberObjects(projectRoot: string, paths: string[]) {
  if (paths.length === 0) return
  const file = path.join(probeDir(projectRoot), "watch.json")
  let current: string[] = []
  try {
    current = (JSON.parse(fs.readFileSync(file, "utf8")) as { paths?: string[] }).paths ?? []
  } catch {}
  const next = [...paths.filter((p) => p.startsWith("/")), ...current.filter((p) => !paths.includes(p))].slice(0, MAX_WATCHED)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ paths: next }, null, 1))
  } catch {}
}

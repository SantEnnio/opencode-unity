import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Platform = "darwin" | "win32" | "linux"

export type UnityProject = {
  root: string
  version: string
}

export type EditorInstall = {
  root: string
  managedDir: string
}

type Env = Record<string, string | undefined>

const currentPlatform = (): Platform =>
  process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux"

/** Walks up from a file or directory until it finds a Unity project root. */
export function findProjectRoot(startPath: string): string | null {
  let dir = path.resolve(startPath)
  for (;;) {
    if (fs.existsSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function parseProjectVersion(content: string): string | null {
  return /^m_EditorVersion:\s*(\S+)/m.exec(content)?.[1] ?? null
}

export function loadProject(startPath: string): UnityProject | null {
  const root = findProjectRoot(startPath)
  if (!root) return null
  const file = path.join(root, "ProjectSettings", "ProjectVersion.txt")
  const version = parseProjectVersion(fs.readFileSync(file, "utf8"))
  return version ? { root, version } : null
}

/** Directories where Unity Hub installs editors, most likely first. */
export function hubInstallDirs(platform: Platform, env: Env, home: string): string[] {
  const p = platform === "win32" ? path.win32 : path.posix
  const dirs: string[] = []

  const hubConfig =
    platform === "win32"
      ? env.APPDATA && p.join(env.APPDATA, "UnityHub")
      : platform === "darwin"
        ? p.join(home, "Library", "Application Support", "UnityHub")
        : p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "UnityHub")
  if (hubConfig) {
    const secondary = readSecondaryInstallPath(path.join(hubConfig, "secondaryInstallPath.json"))
    if (secondary) dirs.push(secondary)
  }

  if (platform === "win32") {
    dirs.push(p.join(env.ProgramFiles || "C:\\Program Files", "Unity", "Hub", "Editor"))
  } else if (platform === "darwin") {
    dirs.push("/Applications/Unity/Hub/Editor")
  } else {
    dirs.push(p.join(home, "Unity", "Hub", "Editor"))
  }
  return dirs
}

function readSecondaryInstallPath(file: string): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * The managed assemblies moved between Unity versions (6000.0 and 6000.3 differ on macOS),
 * so every known layout is probed instead of being derived from the version number.
 */
const MANAGED_LAYOUTS = [
  ["Unity.app", "Contents", "Resources", "Scripting", "Managed"],
  ["Unity.app", "Contents", "Managed"],
  ["Editor", "Data", "Resources", "Scripting", "Managed"],
  ["Editor", "Data", "Managed"],
]

export function findManagedDir(editorRoot: string): string | null {
  for (const layout of MANAGED_LAYOUTS) {
    const dir = path.join(editorRoot, ...layout)
    if (fs.existsSync(path.join(dir, "UnityEngine", "UnityEngine.CoreModule.dll"))) return dir
  }
  return null
}

const EXECUTABLE_LAYOUTS = [
  ["Unity.app", "Contents", "MacOS", "Unity"],
  ["Editor", "Unity.exe"],
  ["Editor", "Unity"],
]

export function findEditorExecutable(editorRoot: string): string | null {
  for (const layout of EXECUTABLE_LAYOUTS) {
    const file = path.join(editorRoot, ...layout)
    if (fs.existsSync(file)) return file
  }
  return null
}

/** Accepts the Unity executable, the Unity.app bundle or the versioned install directory. */
export function editorRootFromOverride(override: string): string | null {
  let dir = path.resolve(override)
  for (let i = 0; i < 5; i++) {
    if (findManagedDir(dir)) return dir
    dir = path.dirname(dir)
  }
  return null
}

export function findEditor(
  version: string,
  options: { editorPath?: string; env?: Env; platform?: Platform; home?: string } = {},
): EditorInstall | null {
  const env = options.env ?? process.env
  const override = options.editorPath ?? env.UNITY_EDITOR_PATH
  const roots: string[] = []

  if (override) {
    const root = editorRootFromOverride(override)
    if (root) roots.push(root)
  }
  for (const dir of hubInstallDirs(options.platform ?? currentPlatform(), env, options.home ?? os.homedir())) {
    roots.push(path.join(dir, version))
  }

  for (const root of roots) {
    const managedDir = findManagedDir(root)
    if (managedDir) return { root, managedDir }
  }
  return null
}

export function cacheDir(platform: Platform = currentPlatform(), env: Env = process.env, home = os.homedir()): string {
  const p = platform === "win32" ? path.win32 : path.posix
  if (platform === "win32") return p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), "opencode-unity")
  if (platform === "darwin") return p.join(home, "Library", "Caches", "opencode-unity")
  return p.join(env.XDG_CACHE_HOME || p.join(home, ".cache"), "opencode-unity")
}

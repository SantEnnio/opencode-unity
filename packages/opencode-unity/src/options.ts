import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type UnityPluginOptions = {
  /** Compile after every edit of a .cs file (default true) */
  compileOnEdit?: boolean
  /**
   * auto: `dotnet build` when Unity has generated the .csproj files, otherwise the open Editor.
   * dotnet / editor force one route for the compile-on-edit check.
   */
  compileBackend?: "auto" | "dotnet" | "editor"
  /** Unity-specific lints on edited scripts (default true) */
  lint?: boolean
  /** When the model stops while the build is red, send it back to fix the errors (default true) */
  idleGate?: boolean
  /** How many times in a row the idle gate may push the model (default 2) */
  idleGateRetries?: number
  /** Add the short Unity rules block to the system prompt (default true) */
  rules?: boolean
  /**
   * simple (default): one flat tool per scene action, for small models.
   * batch: a single unity_scene_edit taking a list of operations, for strong models. both: all of them.
   */
  sceneTools?: "simple" | "batch" | "both"
  /** Register the `unity-coder` agent (default true) */
  agent?: boolean
  /** manual: docs are installed on request only. auto: download them in the background when missing. */
  docs?: "manual" | "auto"
  /** Guard rule ids to switch off: meta, generated, project-files, serialized-asset, project-settings, package-manifest */
  allow?: string[]
  /** Static methods `unity_run_method` may execute with -executeMethod, e.g. "MyGame.Editor.Builder.Build" */
  executeMethods?: string[]
  /** Unity executable or install directory; overrides UNITY_EDITOR_PATH and the Hub lookup */
  editorPath?: string
  maxErrors?: number
  compileTimeoutMs?: number
}

export const configDir = (env: Record<string, string | undefined> = process.env) =>
  env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")

function readJson(file: string): UnityPluginOptions {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return typeof value === "object" && value !== null ? (value as UnityPluginOptions) : {}
  } catch {
    return {}
  }
}

/**
 * Later sources win: global file < project file < options passed in opencode.json.
 * The files exist so that a plugin dropped into the plugins folder (which cannot receive
 * options) and opencode desktop users can still be configured.
 */
export function loadOptions(projectDir: string, inline: unknown): UnityPluginOptions {
  return {
    ...readJson(path.join(configDir(), "opencode-unity", "config.json")),
    ...readJson(path.join(projectDir, ".opencode", "unity.json")),
    ...(typeof inline === "object" && inline !== null ? (inline as UnityPluginOptions) : {}),
  }
}

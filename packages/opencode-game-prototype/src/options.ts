import fs from "node:fs"
import path from "node:path"
import { configDir } from "../../opencode-unity/src/options.ts"

export type PrototypeOptions = {
  /** Load the page in a browser after every edit of a prototype file (default true) */
  checkOnEdit?: boolean
  /** When the model stops while the page has errors, send it back to fix them (default true) */
  idleGate?: boolean
  /** How many times in a row the idle gate may push the model (default 2) */
  idleGateRetries?: number
  /** Add the short rules block to the system prompt (default true) */
  rules?: boolean
  /** Register the `game-prototyper` agent (default true) */
  agent?: boolean
  /** Run the tests in a browser with no window (default true). False: only in the tab the user keeps open */
  headless?: boolean
  /** Edge or Chrome executable for the tests; overrides the lookup in the usual places */
  browserPath?: string
  /** Port of the local server (default 4317, or any free one when it is taken) */
  port?: number
}

function readJson(file: string): PrototypeOptions {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return typeof value === "object" && value !== null ? (value as PrototypeOptions) : {}
  } catch {
    return {}
  }
}

/** Later sources win: global file < project file < options passed in opencode.json. */
export function loadOptions(projectDir: string, inline: unknown): PrototypeOptions {
  return {
    ...readJson(path.join(configDir(), "opencode-game-prototype", "config.json")),
    ...readJson(path.join(projectDir, ".opencode", "game-prototype.json")),
    ...(typeof inline === "object" && inline !== null ? (inline as PrototypeOptions) : {}),
  }
}

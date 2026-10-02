// Everything the plugin does, written against neither opencode API: src/host-v1.ts and
// src/host-v2.ts connect it to opencode 1 and opencode 2.

import fs from "node:fs"
import path from "node:path"
import pluginPackage from "../package.json" with { type: "json" }
import { arg, defineTool, optional, type ToolSpec } from "../../opencode-unity/src/args.ts"
import { writtenPaths } from "../../opencode-unity/src/written-paths.ts"
import { fixFor, instead, threeExports, unknownNames } from "./api.ts"
import { findBrowser, launchHeadless } from "./browser.ts"
import { parseWebKeys } from "./keys.ts"
import { loadOptions } from "./options.ts"
import { assetsDir, cleanName, createPrototype, listPrototypes, place, type Prototype, prototypeOf, revision, threeSource } from "./project.ts"
import { checkReport, type Outcome, playReport, tabNote } from "./report.ts"
import { AGENT_PROMPT, renderRules } from "./rules.ts"
import { createServer } from "./server.ts"

export type Log = (level: "info" | "warn" | "error", message: string) => void

export const PROTO_COMMAND = {
  name: "prototype",
  description: "opencode-game-prototype: is the plugin active, which prototypes exist, and where to open them?",
  template: "Call the proto_status tool and show me its output exactly as returned, in a code block. Do nothing else.",
}

export const PROTO_AGENT = {
  name: "game-prototyper",
  description: "Quick three.js game prototypes, checked in a real browser on every edit and tested with key presses. Pair it with a small/local model.",
  temperature: 0.2,
}

type KeyScript = Exclude<ReturnType<typeof parseWebKeys>, string>

type SessionState = {
  /** The last check or test play of this session's prototype listed errors */
  failing: boolean
  report: string
  nudges: number
  /** The prototype this session last created, edited or played */
  current?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  /** What the user's tab showed, to go with their next messages, and the tab report it came from */
  note?: string
  noteTurns?: number
  noteMessage?: string
  seenTab?: number
}

// A note is only about a game the user has just tried.
const NOTE_MAX_AGE_MS = 30 * 60_000
const NOTE_TURNS = 2

// Files whose edit can change what the page does.
const CHECKED = new Set([".js", ".mjs", ".html", ".css", ".json"])
const CHECK_SECONDS = 1
const WATCH_SECONDS = 2
// A browser start, the wait for a first frame and the report's way back, on a slow machine.
const OVERHEAD_MS = 15_000

/** Null when the plugin's own files are missing: nothing can be created or served. */
export function createPrototypes(directory: string, rawOptions: unknown, log: Log) {
  const options = loadOptions(directory, rawOptions)
  const where = place(directory)
  const assets = assetsDir()
  const three = assets ? threeSource(assets) : null
  if (!assets || !three) {
    log("error", "the template, the probe or three.js is missing from this install: the plugin stays off")
    return null
  }

  const threeRevision = revision(three.version)
  log("info", `opencode-game-prototype ${pluginPackage.version} active in ${directory} (three.js ${threeRevision})`)
  const all = () => listPrototypes(where.root)
  const server = createServer({
    folder: (name) => all().find((p) => p.name === name)?.dir ?? null,
    names: () => all().map((p) => p.name),
    probe: fs.readFileSync(path.join(assets, "probe.js"), "utf8"),
    preferredPort: options.port,
  })

  const sessions = new Map<string, SessionState>()
  const session = (id: string) => {
    let state = sessions.get(id)
    if (!state) sessions.set(id, (state = { failing: false, report: "", nudges: 0 }))
    return state
  }

  /** A path as the model should write it: relative to where opencode runs, with forward slashes. */
  const shown = (file: string, from: string) => path.relative(from, file).split(path.sep).join("/") || "."
  const address = (port: number, name: string) => `http://127.0.0.1:${port}/${name}/`

  const exports = threeExports(three.dir)
  const testBrowser = () => (options.headless === false ? null : findBrowser(options.browserPath))

  /** three.js names in the prototype's own scripts that this version does not have. */
  function wrongNames(prototype: Prototype): NonNullable<Outcome["unknown"]> {
    let files: string[]
    try {
      files = fs.readdirSync(prototype.dir).filter((file) => /\.m?js$/.test(file))
    } catch {
      return []
    }
    return files.flatMap((file) => {
      let source = ""
      try {
        source = fs.readFileSync(path.join(prototype.dir, file), "utf8")
      } catch {
        // gone in the meantime
      }
      return unknownNames(source, exports).map((u) => ({ file, line: u.line, name: u.name, instead: instead(u.name, exports) }))
    })
  }

  // One page at a time: two browsers at once would fight over the machine and blur the timing.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => {})
    return next
  }

  /**
   * Loads the prototype in a browser, presses the keys, and returns what the probe saw. Without a
   * browser that can run with no window, the user's own tab plays it. Returns the text to answer
   * with when nothing could run the page.
   */
  async function playPage(prototype: Prototype, script: KeyScript | null, seconds: number, signal?: AbortSignal): Promise<Outcome | string> {
    const port = await server.start()
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const steps = script ? script.steps : [{ keys: [], hold: 0, wait: seconds }]
    // The game keeps running a second after the last key, to show what the keys caused.
    const tail = script ? 1 : 0
    const budget = OVERHEAD_MS + ((script ? script.total : seconds) + tail) * 1000
    const since = Date.now()
    const reported = server.expect(id, { steps, tail })

    let timer: ReturnType<typeof setTimeout> | undefined
    const giveUp = () =>
      new Promise<null>((resolve) => {
        clearTimeout(timer)
        timer = setTimeout(() => resolve(null), budget)
        signal?.addEventListener("abort", () => resolve(null), { once: true })
      })
    const outcome = (run: Outcome["run"], ranIn: Outcome["ranIn"]): Outcome => ({
      run,
      missing: server.missingSince(prototype.name, since),
      keys: script?.text ?? null,
      held: script?.held ?? 0,
      ranIn,
      unknown: wrongNames(prototype),
      fixFor: (text) => fixFor(text, exports),
    })

    try {
      const browser = testBrowser()
      if (browser) {
        const headless = launchHeadless(browser, `${address(port, prototype.name)}?__run=${id}`)
        const run = await Promise.race([reported, headless.exited.then(() => null), giveUp()])
        headless.close()
        if (run) return outcome(run, "headless")
        if (signal?.aborted) return "[proto] Cancelled."
        log("warn", `${path.basename(browser)} did not report on ${prototype.name}: trying the user's tab`)
      }
      if (server.tabs(prototype.name) > 0) {
        server.tell(prototype.name, "run", id)
        const run = await Promise.race([reported, giveUp()])
        if (run) return outcome(run, "tab")
        return `[proto] The page could NOT be tested: the browser tab with "${prototype.name}" did not answer. Ask the user to bring that tab to the front, then try again.`
      }
      const cause = browser
        ? `${path.basename(browser)} started but did not report, so running it without a window is probably switched off on this machine`
        : options.headless === false
          ? "no browser tab has this prototype open"
          : "no Edge or Chrome was found on this machine"
      return `[proto] The page could NOT be tested: ${cause}. Ask the user to open ${address(port, prototype.name)} in a browser and keep that tab in front. Then try again.`
    } finally {
      clearTimeout(timer)
      server.forget(id)
    }
  }
  /** The prototype a tool call is about: the one named, else the session's, else the only one. */
  function pick(sessionID: string, raw: string | undefined, tool: string): Prototype | string {
    const existing = all()
    if (existing.length === 0) return '[proto] There is no prototype yet. Call proto_new with a short name such as "double-jump".'
    const names = existing.map((p) => p.name).join(", ")
    const wanted = raw?.trim()
    if (wanted) {
      const found = existing.find((p) => p.name === wanted || p.name === cleanName(wanted))
      return found ?? `[proto] No prototype named '${wanted}'. The prototypes are: ${names}. Call ${tool} again with one of these names.`
    }
    const current = existing.find((p) => p.name === sessions.get(sessionID)?.current)
    if (current) return current
    if (existing.length === 1) return existing[0]!
    return `[proto] There are several prototypes: ${names}. Call ${tool} again with name set to the one you mean.`
  }

  const tools: Record<string, ToolSpec<any>> = {
    proto_new: defineTool({
      description:
        'Start a new game prototype. Creates a folder with a three.js page that already runs (a player that moves and jumps, a coin, a score) and tells you which file to edit. Call it once, before writing any code. Example: name "double-jump".',
      args: { name: arg.string('Short name of the feature to try, e.g. "double-jump"') },
      async execute(args, context) {
        const name = cleanName(args.name)
        if (!name) return `[proto] Not created: '${args.name}' has no letters or digits. Call proto_new with a short name such as "double-jump".`
        const dir = path.join(where.root, name)
        const main = shown(path.join(dir, "main.js"), context.directory)
        if (all().some((p) => p.name === name)) {
          session(context.sessionID).current = name
          return `[proto] "${name}" already exists: nothing was created.\n→ Next: read ${main} and continue from there, or call proto_new with another name.`
        }
        if (fs.existsSync(dir)) return `[proto] Not created: a folder named ${shown(dir, context.directory)} already exists and it is not a prototype. Call proto_new with another name.`

        createPrototype(where.root, name)
        session(context.sessionID).current = name
        const port = await server.start()
        return [
          `[proto] Created "${name}" in ${shown(dir, context.directory)} (three.js ${threeRevision}).`,
          "It already runs: a Player box moves with W A S D and jumps with Space, and touching the Coin adds to the score.",
          `The user can watch it at ${address(port, name)} (it reloads on every edit).`,
          `→ Next: read ${main}, then change it one small step at a time.`,
        ].join("\n")
      },
    }),

    proto_play: defineTool({
      description:
        'Run the prototype in a real browser for a few seconds and report what happened: errors, which objects moved and how far, what appeared or was removed, the text on screen. With keys it presses them: keys "D 1s; Space" holds D for one second, then taps Space. Call it after each step that changes what the player can do.',
      args: {
        keys: optional(arg.string('Keys to press, in order. Examples: "D 1s; Space", "W+D 2s", "Space; wait 1s; Space". Leave out to watch the game for 2 seconds.')),
        name: optional(arg.string("Folder name of the prototype. Leave out to use the one you are working on.")),
      },
      async execute(args, context) {
        const prototype = pick(context.sessionID, args.name, "proto_play")
        if (typeof prototype === "string") return prototype
        const script = args.keys?.trim() ? parseWebKeys(args.keys) : null
        if (typeof script === "string") return `[proto] Game NOT tested: ${script}`
        const state = session(context.sessionID)
        state.current = prototype.name
        const outcome = await serial(() => playPage(prototype, script, WATCH_SECONDS, context.abort))
        if (typeof outcome === "string") return outcome
        const { failing, report } = playReport(prototype.name, outcome)
        Object.assign(state, { failing, report })
        return report
      },
    }),

    proto_status: defineTool({
      description: "Show whether the opencode-game-prototype plugin is active, which prototypes exist, the address to open each one at, and which browser runs the tests. Return its output to the user unchanged.",
      args: {},
      async execute(_args, context) {
        const existing = all()
        const browser = testBrowser()
        const port = existing.length > 0 ? await server.start() : null
        const folder = shown(where.root, context.directory)
        return [
          `opencode-game-prototype ${pluginPackage.version}: ACTIVE`,
          `Prototypes folder: ${folder === "." ? "this folder" : folder}${where.engine ? ` (beside the ${where.engine} project)` : ""}`,
          `three.js: ${threeRevision}`,
          `Browser for the tests: ${browser ? `${path.basename(browser)}, with no window` : `${options.headless === false ? "switched off" : "no Edge or Chrome found"}: tests run in the tab the user keeps open`}`,
          `Check on every edit: ${options.checkOnEdit === false ? "off" : "on"}`,
          existing.length === 0 ? 'Prototypes: none yet. Start one with proto_new, for example name "double-jump".' : "Prototypes:",
          ...existing.map((p) => `- ${p.name}: ${address(port!, p.name)}${server.tabs(p.name) > 0 ? " (open in the user's browser)" : ""}`),
        ].join("\n")
      },
    }),
  }

  /** Refuses writes into vendor/. Returns the reason, or null when the write may go ahead. */
  function guardWrite(toolName: string, args: unknown, directory: string): string | null {
    for (const file of writtenPaths(toolName, args, directory)) {
      const hit = prototypeOf(where.root, file)
      if (hit?.inside.startsWith("vendor/")) {
        return `[proto] Blocked: ${hit.inside} is part of three.js and the kit, which are fixed. Write your code in main.js, or in a new .js file next to it that main.js imports.`
      }
    }
    return null
  }

  /** After a write to a prototype file: reload the user's tab, load the page in a browser, report. */
  async function afterWrite(toolName: string, args: unknown, sessionID: string, directory: string): Promise<string | null> {
    try {
      const hit = writtenPaths(toolName, args, directory)
        .map((file) => prototypeOf(where.root, file))
        .find((found) => found !== null && CHECKED.has(path.extname(found.inside).toLowerCase()))
      if (!hit) return null
      const state = session(sessionID)
      state.current = hit.prototype.name
      server.tell(hit.prototype.name, "reload")
      if (options.checkOnEdit === false) return null
      const outcome = await serial(() => playPage(hit.prototype, null, CHECK_SECONDS))
      if (typeof outcome === "string") return outcome
      const { failing, report } = checkReport(hit.prototype.name, outcome)
      Object.assign(state, { failing, report })
      return report
    } catch (error) {
      log("error", `page check failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * A new user message: the idle gate gets a fresh budget, and remembers who to answer as. If the
   * user's own tab showed errors since the last note, they go with this message and the next one.
   */
  function userMessage(sessionID: string, who: { agent?: string; model?: { providerID: string; modelID: string } } = {}, messageID?: string) {
    const state = session(sessionID)
    Object.assign(state, { nudges: 0, ...who })
    const existing = all()
    const name = existing.find((p) => p.name === state.current)?.name ?? (existing.length === 1 ? existing[0]!.name : undefined)
    const tab = name ? server.tabReport(name) : null
    const note = name && tab && tab.at !== state.seenTab && Date.now() - tab.at < NOTE_MAX_AGE_MS ? tabNote(name, tab, (text) => fixFor(text, exports)) : null
    if (note) Object.assign(state, { seenTab: tab!.at, note, noteTurns: NOTE_TURNS, noteMessage: messageID })
    else if (state.noteTurns) state.noteTurns--
  }

  /** The note for this session's next model request, and the user message it goes with. */
  function playNote(sessionID: string): { text: string; messageID?: string } | null {
    const state = sessions.get(sessionID)
    return state?.note && state.noteTurns ? { text: state.note, messageID: state.noteMessage } : null
  }

  /** The session stopped. Returns the message that sends the model back while the page has errors, or null. */
  function idle(sessionID: string): { text: string; agent?: string; model?: { providerID: string; modelID: string } } | null {
    if (options.idleGate === false) return null
    const state = sessions.get(sessionID)
    if (!state || !state.failing || state.nudges >= (options.idleGateRetries ?? 2)) return null
    state.nudges++
    return { text: `You stopped, but the prototype has errors. Fix them now, then stop.\n\n${state.report}`, agent: state.agent, model: state.model }
  }

  /**
   * The rules block, for the sessions it concerns: the game-prototyper agent anywhere, and any
   * agent in a folder that holds prototypes and is not an engine project (there, another plugin's
   * rules are the ones that matter to the other agents).
   */
  function rules(sessionID: string | undefined, agent?: string): string | null {
    if (options.rules === false) return null
    const who = agent ?? (sessionID ? sessions.get(sessionID)?.agent : undefined)
    if (who !== PROTO_AGENT.name && (where.engine !== null || all().length === 0)) return null
    return renderRules({ revision: threeRevision, folder: shown(where.root, directory), engine: where.engine })
  }

  return {
    place: where,
    options,
    tools,
    guardWrite,
    afterWrite,
    userMessage,
    playNote,
    idle,
    rules,
    forget: (sessionID: string) => sessions.delete(sessionID),
    agent: options.agent === false ? null : { ...PROTO_AGENT, prompt: AGENT_PROMPT },
    dispose: () => server.close(),
  }
}

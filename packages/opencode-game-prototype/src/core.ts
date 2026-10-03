// Everything the plugin does, written against neither opencode API: src/host-v1.ts and
// src/host-v2.ts connect it to opencode 1 and opencode 2.

import fs from "node:fs"
import path from "node:path"
import pluginPackage from "../package.json" with { type: "json" }
import { arg, defineTool, optional, type ToolSpec } from "../../opencode-unity/src/args.ts"
import { writtenPaths } from "../../opencode-unity/src/written-paths.ts"
import { fixFor, instead, kitMistakes, threeExports, unknownNames } from "./api.ts"
import { findBrowser, launchHeadless } from "./browser.ts"
import { JOURNAL_DIR, journal, readJournal, renderSession, SESSION_FILE } from "./journal.ts"
import { parseWebKeys } from "./keys.ts"
import { createLookup } from "./lookup.ts"
import { loadOptions } from "./options.ts"
import { checkExpectation, markStatus, parsePlan, type Phase, PLAN_FILE, planProblems, planReady, runnable, withForms } from "./plan.ts"
import { assetsDir, cleanName, createPrototype, listPrototypes, place, type Prototype, prototypeOf, revision, threeSource } from "./project.ts"
import { checkReport, movement, type Outcome, playReport, problems, tabNote } from "./report.ts"
import { AGENT_PROMPT, renderRules } from "./rules.ts"
import { createServer } from "./server.ts"

export type Log = (level: "info" | "warn" | "error", message: string) => void

export const PROTO_COMMANDS = [
  {
    name: "prototype",
    description: "opencode-game-prototype: is the plugin active, which prototypes exist, and where to open them?",
    template: "Call the proto_status tool and show me its output exactly as returned, in a code block. Do nothing else.",
  },
  {
    name: "prototype-export",
    description: "opencode-game-prototype: write SESSION.md, the report of the work on the current prototype, to hand in with the folder",
    template: "Call the proto_export tool and show me its output exactly as returned. Do nothing else.",
  },
]

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
  const lookup = createLookup(three.dir, threeRevision)
  const testBrowser = () => (options.headless === false ? null : findBrowser(options.browserPath))

  const readText = (file: string): string | null => {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return null
    }
  }
  const problemsOf = (outcome: Outcome) => problems(outcome).map((p) => `${p.text}${p.fix ? `. FIX: ${p.fix}` : ""}`)

  /** three.js names this version does not have, and uses of the kit that do not exist, in the prototype's own scripts. */
  function wrongNames(prototype: Prototype): { unknown: NonNullable<Outcome["unknown"]>; mistakes: NonNullable<Outcome["mistakes"]> } {
    const unknown: NonNullable<Outcome["unknown"]> = []
    const mistakes: NonNullable<Outcome["mistakes"]> = []
    let files: string[] = []
    try {
      files = fs.readdirSync(prototype.dir).filter((file) => /\.m?js$/.test(file))
    } catch {
      // unreadable: nothing to say
    }
    for (const file of files) {
      const source = readText(path.join(prototype.dir, file)) ?? ""
      unknown.push(...unknownNames(source, exports).map((u) => ({ file, line: u.line, name: u.name, instead: instead(u.name, exports) })))
      mistakes.push(...kitMistakes(source).map((m) => ({ file, ...m })))
    }
    return { unknown, mistakes }
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
      unknown: wrongNames(prototype).unknown,
      mistakes: wrongNames(prototype).mistakes,
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
        journal(path.join(where.root, name), { session: context.sessionID, event: "new", detail: { name } })
        session(context.sessionID).current = name
        const port = await server.start()
        const plan = shown(path.join(dir, PLAN_FILE), context.directory)
        return [
          `[proto] Created "${name}" in ${shown(dir, context.directory)} (three.js ${threeRevision}).`,
          "It already runs: a Player box moves with W A S D and jumps with Space, the camera follows it, and touching the Coin adds to the score.",
          `The user can watch it at ${address(port, name)} (it reloads on every edit).`,
          `→ Next: read ${main}, then write ${plan}: the idea, and the phases with their Test and Expect lines. ${main} cannot be changed before that.`,
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
        journal(prototype.dir, { session: context.sessionID, event: "play", detail: { keys: script?.text ?? null, failing }, text: report })
        return report
      },
    }),

    proto_test: defineTool({
      description:
        'Run the tests written in PLAN.md: for each phase, press its Test keys in a real browser and check every Expect line. Reports PASSED or FAILED per phase, with what was seen instead, and writes the result next to the phase. Call it after each change, with the phase you are working on: phase "2".',
      args: {
        phase: optional(arg.string('The phase to test, by number: "2". Leave out to test every phase.')),
        name: optional(arg.string("Folder name of the prototype. Leave out to use the one you are working on.")),
      },
      async execute(args, context) {
        const prototype = pick(context.sessionID, args.name, "proto_test")
        if (typeof prototype === "string") return prototype
        const state = session(context.sessionID)
        state.current = prototype.name
        const planFile = path.join(prototype.dir, PLAN_FILE)
        const planText = readText(planFile)
        if (planText === null) return `[proto] ${shown(planFile, context.directory)} does not exist. Write it: the idea, then phases with a Test line and Expect lines.`
        const phases = parsePlan(planText).phases
        let chosen = phases
        if (args.phase?.trim()) {
          const wanted = args.phase.trim().toLowerCase()
          const number = Number(/\d+/.exec(wanted)?.[0])
          const found = phases.find((p) => p.number === number) ?? phases.find((p) => p.title.toLowerCase().includes(wanted))
          if (!found) return `[proto] No phase '${args.phase}' in PLAN.md. The phases are: ${phases.map((p) => `${p.number} (${p.title})`).join(", ") || "none"}. Call proto_test again with one of their numbers.`
          chosen = [found]
        }
        const ready = chosen.filter(runnable)
        if (ready.length === 0) {
          const why = planProblems(planText).slice(0, 4).map((p) => `- ${p}`)
          return [`[proto] Nothing to test: ${chosen.length === 1 ? `phase ${chosen[0]!.number}` : "no phase"} has a Test line and Expect lines the plugin can run.`, ...why, `→ Next: fix ${shown(planFile, context.directory)}, then call proto_test again.`].join("\n")
        }

        const lines: string[] = []
        const passedPhases = new Set<number>()
        let text = planText
        for (const phase of ready) {
          const script = parseWebKeys(phase.test!)
          if (typeof script === "string") continue
          const outcome = await serial(() => playPage(prototype, script, WATCH_SECONDS, context.abort))
          if (typeof outcome === "string") return outcome
          const verdicts = phase.expects.map((expect) => checkExpectation(expect, outcome))
          const errors = problemsOf(outcome)
          const ok = errors.length === 0 && verdicts.every((v) => v.ok === true)
          if (ok) passedPhases.add(phase.number)
          text = markStatus(text, phase.number, ok ? "passed" : "failed")
          lines.push(`Phase ${phase.number} (${phase.title}): ${ok ? "PASSED" : "FAILED"}`)
          for (const error of errors.slice(0, 3)) lines.push(`- error: ${error}`)
          for (const v of verdicts) {
            if (v.ok === true && !ok) lines.push(`- ${v.expect}: yes`)
            else if (v.ok === false) lines.push(`- ${v.expect}: NO. ${v.seen}`)
            else if (v.ok === null) lines.push(`- ${v.expect}: cannot be checked, ${v.seen}`)
          }
          if (!ok) {
            const seen = movement(outcome).slice(0, 6)
            if (seen.length > 0) lines.push("Seen:", ...seen.map((line) => `  ${line}`))
          }
        }
        try {
          if (text !== planText) fs.writeFileSync(planFile, text)
        } catch (error) {
          log("warn", `PLAN.md not updated: ${error instanceof Error ? error.message : String(error)}`)
        }
        const failing = passedPhases.size < ready.length
        const skipped = chosen.length - ready.length
        const head = `[proto] Tests of "${prototype.name}": ${passedPhases.size} of ${ready.length} phase${ready.length === 1 ? "" : "s"} pass${skipped > 0 ? ` (${skipped} without a runnable test)` : ""}.`
        const firstFailed = ready.find((p) => !passedPhases.has(p.number))
        const next = firstFailed
          ? `→ Next: make phase ${firstFailed.number} pass: change the code, then call proto_test with phase "${firstFailed.number}".`
          : chosen.length === phases.length
            ? "→ Next: every phase passes. Write the numbers that worked in PLAN.md, then stop and summarise."
            : "→ Next: go on to the next phase of PLAN.md."
        const report = [head, ...lines, next].join("\n")
        Object.assign(state, { failing, report })
        journal(prototype.dir, { session: context.sessionID, event: "test", detail: { phase: args.phase?.trim() || null, passed: passedPhases.size, total: ready.length }, text: report })
        writeSession(prototype)
        return report
      },
    }),

    proto_lookup: defineTool({
      description:
        'Look up a three.js class in the exact version of this prototype: its fields and methods, or whether one member exists. Examples: "Mesh", "Vector3.distanceTo", "Object3D.lookAt". Call it before using a three.js method you are not sure about.',
      args: { name: arg.string('Class, or Class.member, e.g. "Mesh" or "Vector3.distanceTo"') },
      async execute(args, context) {
        const answer = await lookup(args.name)
        const prototype = pick(context.sessionID, undefined, "proto_lookup")
        if (typeof prototype !== "string") journal(prototype.dir, { session: context.sessionID, event: "lookup", detail: { query: args.name }, text: answer })
        return answer
      },
    }),

    proto_export: defineTool({
      description:
        "Write SESSION.md inside the prototype: the plan as it stands, the numbers (edits, checks, tests passed), a timeline of everything the plugin saw, and every phase test in full. Call it when the user asks for a report of the work, or at the end.",
      args: { name: optional(arg.string("Folder name of the prototype. Leave out to use the one you are working on.")) },
      async execute(args, context) {
        const prototype = pick(context.sessionID, args.name, "proto_export")
        if (typeof prototype === "string") return prototype
        journal(prototype.dir, { session: context.sessionID, event: "export", detail: {} })
        const file = writeSession(prototype)
        if (!file) return `[proto] ${SESSION_FILE} could not be written in ${shown(prototype.dir, context.directory)}.`
        const entries = readJournal(prototype.dir)
        const tests = entries.filter((e) => e.event === "test")
        return `[proto] Report written: ${shown(file, context.directory)} (${entries.length} events, ${tests.length} phase tests, ${entries.filter((e) => e.event === "check").length} checked edits). The whole folder ${shown(prototype.dir, context.directory)} is the thing to hand in: code, PLAN.md, SESSION.md and .proto/journal.jsonl.`
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

  /**
   * Refuses writes into vendor/, and changes to the code before PLAN.md is written. Returns the
   * reason, or null when the write may go ahead.
   */
  function guardWrite(toolName: string, args: unknown, directory: string, sessionID = ""): string | null {
    for (const file of writtenPaths(toolName, args, directory)) {
      const hit = prototypeOf(where.root, file)
      if (!hit) continue
      let reason: string | null = null
      if (hit.inside.startsWith("vendor/")) {
        reason = `[proto] Blocked: ${hit.inside} is part of three.js and the kit, which are fixed. Write your code in main.js, or in a new .js file next to it that main.js imports.`
      } else if (hit.inside === SESSION_FILE || hit.inside.startsWith(`${JOURNAL_DIR}/`)) {
        reason = `[proto] Blocked: ${hit.inside} is the plugin's own record of this prototype. It is written by proto_test and proto_export, not by hand.`
      } else if (options.planFirst !== false && hit.inside !== PLAN_FILE && CHECKED.has(path.extname(hit.inside).toLowerCase())) {
        const plan = readText(path.join(hit.prototype.dir, PLAN_FILE))
        if (plan !== null && !planReady(plan)) {
          const why = planProblems(plan).slice(0, 3).join("; ")
          reason = `[proto] Blocked: write ${shown(path.join(hit.prototype.dir, PLAN_FILE), directory)} first. ${why}. Then change ${hit.inside}.`
        }
      }
      if (reason) {
        journal(hit.prototype.dir, { session: sessionID, event: "blocked", detail: { file: hit.inside }, text: reason })
        return reason
      }
    }
    return null
  }

  /** After a write to a prototype file: reload the user's tab, load the page in a browser, report. */
  async function afterWrite(toolName: string, args: unknown, sessionID: string, directory: string): Promise<string | null> {
    try {
      const written = writtenPaths(toolName, args, directory).map((file) => prototypeOf(where.root, file))
      const plan = written.find((found) => found?.inside === PLAN_FILE)
      if (plan) {
        session(sessionID).current = plan.prototype.name
        const feedback = planFeedback(plan.prototype, directory)
        const text = readText(path.join(plan.prototype.dir, PLAN_FILE)) ?? ""
        journal(plan.prototype.dir, { session: sessionID, event: "plan", detail: { ready: planReady(text), phases: parsePlan(text).phases.length, problems: planProblems(text).length }, text: feedback })
        return feedback
      }
      const hit = written.find((found) => found !== null && CHECKED.has(path.extname(found.inside).toLowerCase()))
      if (!hit) return null
      const state = session(sessionID)
      state.current = hit.prototype.name
      server.tell(hit.prototype.name, "reload")
      if (options.checkOnEdit === false) return null
      const outcome = await serial(() => playPage(hit.prototype, null, CHECK_SECONDS))
      if (typeof outcome === "string") return outcome
      const { failing, report } = checkReport(hit.prototype.name, outcome)
      Object.assign(state, { failing, report })
      journal(hit.prototype.dir, { session: sessionID, event: "check", detail: { file: hit.inside, failing }, text: report })
      return report
    } catch (error) {
      log("error", `page check failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** SESSION.md from the journal; returns its path, or null when it could not be written. */
  function writeSession(prototype: Prototype): string | null {
    const file = path.join(prototype.dir, SESSION_FILE)
    try {
      fs.writeFileSync(file, renderSession(prototype.name, prototype.dir, readJournal(prototype.dir), { version: pluginPackage.version, three: threeRevision }))
      return file
    } catch (error) {
      log("warn", `${SESSION_FILE} not written: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** What the plan still lacks, or the first phase to build. */
  function planFeedback(prototype: Prototype, directory: string): string {
    const planFile = path.join(prototype.dir, PLAN_FILE)
    let text = readText(planFile) ?? ""
    // A rewrite that dropped the forms section leaves the model with nothing to copy: put it back.
    const restored = withForms(text)
    if (restored !== text) {
      try {
        fs.writeFileSync(planFile, restored)
        text = restored
      } catch {
        // read-only: the message below still carries the forms
      }
    }
    const phases = parsePlan(text).phases
    const ready = phases.filter(runnable)
    const missing = planProblems(text)
    const main = shown(path.join(prototype.dir, "main.js"), directory)
    if (!planReady(text)) {
      return [`[proto] Plan not ready: ${shown(planFile, directory)} cannot be used yet.`, ...missing.slice(0, 5).map((p) => `- ${p}`), `→ Next: fix these in ${shown(planFile, directory)}. ${main} stays locked until then.`].join("\n")
    }
    const lines = [`[proto] Plan read: ${ready.length} of ${phases.length} phase${phases.length === 1 ? "" : "s"} have a test the plugin can run.`]
    for (const p of missing.slice(0, 5)) lines.push(`- ${p}`)
    const first: Phase | undefined = ready.find((p) => p.status === null || /todo|failed/i.test(p.status))
    lines.push(first ? `→ Next: build phase ${first.number} (${first.title}): change ${main}, then call proto_test with phase "${first.number}".` : "→ Next: every phase has passed. Write the numbers that worked, then stop and summarise.")
    return lines.join("\n")
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
    const what = state.report.startsWith("[proto] Tests") ? "a phase of the prototype still fails its test" : "the prototype has errors"
    return { text: `You stopped, but ${what}. Fix it now, then stop.\n\n${state.report}`, agent: state.agent, model: state.model }
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

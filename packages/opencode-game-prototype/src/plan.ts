// PLAN.md: the document a prototype starts from. The idea, then phases, each with a test the
// plugin can run: keys to press and plain-text expectations about what the page must show
// afterwards. The plugin reads the plan, runs the tests, writes the result back next to each phase.

import { parseWebKeys } from "./keys.ts"
import { colorName, type Outcome, problems, type Track } from "./report.ts"

export type Phase = {
  number: number
  title: string
  /** The key script of the Test line, or null when the phase has none */
  test: string | null
  expects: string[]
  status: string | null
  /** Line index of the heading, and of the line after the phase's last list item */
  heading: number
  end: number
}

export const PLAN_FILE = "PLAN.md"

/** The Expect forms, as they stand at the end of the template. Models delete that section when they rewrite the file. */
export const FORMS_HEADING = "## Forms for Expect lines"
export const FORMS = [
  "- `Player moves` · `Player moves right` (also left, up, down, forward, back) · `Player moves back and forth` · `Player does not move`",
  "- `Player jumps` · `Player jumps 2 times` · `Player rises at least 1` · `Player falls` · `Player is reset` (jumps back to a far position)",
  "- `Coin is removed` · `Bullet appears` · `Bullet appears 3 times` · `Enemy turns red` · `Enemy changes colour`",
  "- `Player x > 4` · `Player y < 0` · `Player z = 0` (where it ended; also >=, <=) · `Player ends at (0, 0.5, 0)`",
  "- `Player is above Platform` · `Player is on Platform` (ends above it, within its reach)",
  '- `text contains "Score 1"` · `text is "GAME OVER"` · `text does not contain "GAME OVER"`',
  "- `Player is off screen` · `Player is on screen` · `no errors`",
  "- `Player does not move after the text changes` · `no Enemy appears after the text changes` · `nothing moves after the text changes` (for a game that must stop at GAME OVER)",
  "",
  'Names are the object names in main.js (`player.name = "Player"`); `Enemy` also means Enemy0, Enemy1...',
  "Directions: right = x grows, left = x shrinks, up = y grows, down = y shrinks, forward = z shrinks, back = z grows.",
]

/** The plan with its forms section, added back at the end when a rewrite dropped it. */
export function withForms(text: string): string {
  if (/^##\s*forms for expect/im.test(text)) return text
  return `${text.replace(/\s*$/, "")}\n\n${FORMS_HEADING}\n${FORMS.join("\n")}\n`
}

const FORMS_SHORT = "Player moves · Player moves right · Player moves back and forth · Player does not move · Player jumps · Player jumps 2 times · Player rises at least 1 · Player falls · Player is reset · Coin is removed · Bullet appears · Enemy turns red · Player x > 4 · Player ends at (0, 0.5, 0) · Player is above Platform · text contains \"Score 1\" · text is \"GAME OVER\" · Player is off screen · Player does not move after the text changes · no Enemy appears after the text changes · nothing moves after the text changes"
const IDEA_PLACEHOLDER = "Write here, in two sentences"
const PLACEHOLDER = /^\(.*\)$|^\.\.\.$|^…$/

// Quotes come off only as a pair: `text contains "Score 1"` keeps its own.
const unquote = (text: string) => text.trim().replace(/^(["'“])(.*)["'”]$/, "$2").trim()

// "- Test: ...", "* test: ...", "**Test:** `...`", "Test: ..." are all the same line to a model.
const KEYED = /^\s*[-*]?\s*\**\s*(test|expect|expects|expected|status|goal)\s*\**\s*:\s*\**\s*(.*)$/i
const unmark = (text: string) => unquote(text.trim().replace(/^`(.*)`$/, "$1").replace(/\*\*/g, "").trim())

/**
 * Phases and whether an idea was written. The idea is the "## Idea" section, or, when a model
 * drops that heading, any prose before the first phase.
 */
export function parsePlan(text: string): { phases: Phase[]; ideaWritten: boolean } {
  const lines = text.split(/\r?\n/)
  const phases: Phase[] = []
  let fenced = false
  let ideaWritten = false
  let section: "idea" | "other" | "front" = "front"
  let expecting = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) fenced = !fenced
    if (fenced) continue
    const heading = /^#{1,4}\s*(?:phase|fase|step)\s+(\d+)\s*[:.\-–—]?\s*(.*)$/i.exec(line)
    if (heading) {
      phases.push({ number: Number(heading[1]), title: heading[2]!.trim(), test: null, expects: [], status: null, heading: i, end: i + 1 })
      section = "other"
      expecting = false
      continue
    }
    if (/^##\s*idea/i.test(line)) {
      section = "idea"
      continue
    }
    if (/^#/.test(line)) {
      // The title stays "front"; any other heading before the phases is another section.
      if (phases.length === 0 && !/^#\s/.test(line)) section = "other"
      else if (phases.length === 0) section = "front"
      continue
    }
    if ((section === "idea" || section === "front") && line.trim() && !line.includes(IDEA_PLACEHOLDER)) ideaWritten = true
    const phase = phases[phases.length - 1]
    if (!phase) continue
    const item = KEYED.exec(line)
    if (!item) {
      // The lines under a bare "Expect:" are the expectations.
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
      if (expecting && bullet) {
        phase.end = i + 1
        const value = unmark(bullet[1]!)
        if (value && !PLACEHOLDER.test(value)) phase.expects.push(value)
      } else if (line.trim()) expecting = false
      continue
    }
    phase.end = i + 1
    const key = item[1]!.toLowerCase()
    const value = unmark(item[2]!)
    expecting = false
    if (key === "test") {
      const keys = /^keys?\s*(.*)$/i.exec(value)
      const script = unmark(keys ? keys[1]! : value)
      phase.test = script && !PLACEHOLDER.test(script) ? script : null
    } else if (key.startsWith("expect")) {
      if (value && !PLACEHOLDER.test(value)) phase.expects.push(value)
      else expecting = true
    } else if (key === "status") phase.status = value
  }
  return { phases, ideaWritten }
}

/** A phase the plugin can run: its test parses, and it expects something. */
export const runnable = (phase: Phase) => phase.test !== null && typeof parseWebKeys(phase.test) !== "string" && phase.expects.length > 0

// The phase the template comes with. It passes on the starter game; it is not the model's plan.
const SAMPLE = { title: "the player moves and jumps", test: "D 1s; Space", expects: ["Player moves right", "Player jumps"] }
const isSample = (phase: Phase) => phase.title === SAMPLE.title && phase.test === SAMPLE.test && phase.expects.join("|") === SAMPLE.expects.join("|")

/** The plan is written when the idea is, and a phase of its own has a test the plugin can run. */
export function planReady(text: string): boolean {
  const plan = parsePlan(text)
  return plan.ideaWritten && plan.phases.some((phase) => runnable(phase) && !isSample(phase))
}

/** What is still missing from a plan, for the model; null when nothing is. */
export function planProblems(text: string): string[] {
  const plan = parsePlan(text)
  const found: string[] = []
  if (!plan.ideaWritten) found.push("the Idea section is still the placeholder: write what the player does and what the prototype must prove")
  if (plan.phases.length === 0) found.push('there is no "### Phase 1: ..." heading')
  else if (plan.phases.every(isSample)) found.push("the only phase is the sample one: add the phases of this prototype")
  for (const phase of plan.phases) {
    const name = `Phase ${phase.number}`
    if (phase.test === null) found.push(`${name} has no Test line (for example: - Test: keys "D 1s; Space")`)
    else {
      const parsed = parseWebKeys(phase.test)
      if (typeof parsed === "string") found.push(`${name}: its Test line cannot be read. ${parsed}`)
    }
    if (phase.expects.length === 0) found.push(`${name} has no Expect line`)
    for (const expect of phase.expects) {
      if (!understood(expect)) found.push(`${name}: Expect "${expect}" is not a form the plugin can check`)
    }
  }
  // Seen with qwen: the same "Player moved" three times, then the same line in every phase, until
  // everything passed. A test that cannot fail proves nothing.
  const seen = new Map<string, number>()
  for (const phase of plan.phases) {
    const name = `Phase ${phase.number}`
    const distinct = new Set(phase.expects.map((e) => e.toLowerCase().replace(/\s+/g, " ").trim()))
    if (distinct.size < phase.expects.length) found.push(`${name} repeats the same Expect line: each line must check something different`)
    const key = [...distinct].sort().join("|")
    const earlier = seen.get(key)
    if (key && earlier !== undefined) found.push(`${name} expects exactly what phase ${earlier} expects: add what this phase changes (a position, a removed object, the text on screen, a jump count)`)
    else if (key) seen.set(key, phase.number)
  }
  if (found.some((f) => f.includes("is not a form"))) found.push(`Expect lines are English, one per line, in exactly these forms (object names as in main.js): ${FORMS_SHORT}`)
  return found
}

/** Rewrites the Status line of a phase (adds one when the phase has none). */
export function markStatus(text: string, number: number, status: string): string {
  const lines = text.split(/\r?\n/)
  const phase = parsePlan(text).phases.find((p) => p.number === number)
  if (!phase) return text
  for (let i = phase.heading + 1; i < phase.end; i++) {
    if (/^\s*[-*]\s*status\s*:/i.test(lines[i]!)) {
      lines[i] = `- Status: ${status}`
      return lines.join("\n")
    }
  }
  lines.splice(phase.end, 0, `- Status: ${status}`)
  return lines.join("\n")
}

// ---- expectations

export type Verdict = { expect: string; ok: boolean | null; seen: string }

const MOVED = 0.05
const DIRECTIONS: Record<string, [number, 1 | -1, string]> = {
  right: [0, 1, "x grew"],
  left: [0, -1, "x shrank"],
  up: [1, 1, "y grew"],
  down: [1, -1, "y shrank"],
  forward: [2, -1, "z shrank"],
  forwards: [2, -1, "z shrank"],
  back: [2, 1, "z grew"],
  backward: [2, 1, "z grew"],
  backwards: [2, 1, "z grew"],
}

const num = (n: number) => {
  const text = (Math.round(n * 10) / 10).toFixed(1)
  return text === "-0.0" ? "0.0" : text
}
const point = (p: [number, number, number]) => `(${p.map(num).join(", ")})`

type Rule = { pattern: RegExp; check(match: RegExpExecArray, outcome: Outcome): { ok: boolean; seen: string } | string }

/** Did the object move in that direction at some point? From its trace when there is one, else start to end. */
function wentTowards(track: Track, axis: number, sign: 1 | -1): boolean {
  const trace = track.trace ?? []
  if (trace.length >= 2) {
    for (let i = 1; i < trace.length; i++) if ((trace[i]![axis + 1]! - trace[i - 1]![axis + 1]!) * sign > 0.1) return true
    return false
  }
  return (track.end![axis]! - track.start![axis]!) * sign > MOVED
}

/** How far the object got from where it was when the text on screen last changed. */
function movedAfter(track: Track, since: number): number {
  const later = (track.trace ?? []).filter((p) => p[0] >= since)
  const first = later[0]
  if (!first) return 0
  return Math.max(0, ...later.map((p) => Math.hypot(p[1] - first[1], p[2] - first[2], p[3] - first[3])))
}

const AFTER_TEXT = /\s+(?:after|once|since|when) (?:the )?(?:text|hud|screen text)(?: on screen)? (?:changes|changed|appears|appeared|shows .+|says .+|is .+|contains .+|reads .+)$/i
const textChangedAt = (outcome: Outcome) => (typeof outcome.run.hudChanged === "number" ? outcome.run.hudChanged : null)

const lowestY = (track: Track) => Math.min(track.start![1], track.end![1], ...(track.trace ?? []).map((p) => p[2]))

/** A jump of more than 2.5 units between two samples a tenth of a second apart: a reset, a respawn. */
const teleported = (track: Track) => {
  const trace = track.trace ?? []
  for (let i = 1; i < trace.length; i++) {
    const [t0, x0, y0, z0] = trace[i - 1]!
    const [t, x1, y1, z1] = trace[i]!
    const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
    const before = i > 1 ? Math.hypot(x0 - trace[i - 2]![1], y0 - trace[i - 2]![2], z0 - trace[i - 2]![3]) : 0
    // Not the next step of a fast steady fall: a break from what came before.
    if (t - t0 <= 0.3 && d > 2.5 && d > 2.5 * before) return t
  }
  return null
}

/** The tracks an expectation names: "Enemy" also means Enemy0, Enemy1, ... */
function named(name: string, outcome: Outcome): Track[] | string {
  const wanted = name.trim().toLowerCase()
  const all = outcome.run.objects.filter((o) => o.start)
  let found = all.filter((o) => o.label.toLowerCase() === wanted)
  if (found.length === 0) found = all.filter((o) => o.label.toLowerCase().startsWith(wanted))
  if (found.length > 0) return found
  const seen = [...new Set(all.map((o) => o.label))].slice(0, 8).join(", ")
  return `no object named ${name.trim()} was in the scene (seen: ${seen || "nothing"})`
}

const RULES: Rule[] = [
  // Forms about what happens once the text on screen changed (GAME OVER, Score 1...) come first:
  // their tails would otherwise be read as part of an object's name.
  {
    pattern: /^(.+?) (?:does not|doesn't|did not|didn't|stops?|stopped|no longer) mov(?:e|es|ing)(?: any ?more)?(?= after| once| since| when)/i,
    check: (m, outcome) => {
      if (!AFTER_TEXT.test(clean(m.input!))) return "not one of the forms at the end of PLAN.md"
      const since = textChangedAt(outcome)
      if (since === null) return { ok: false, seen: `the text on screen never changed (it was "${outcome.run.hud[1]}")` }
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const moved = tracks.find((o) => movedAfter(o, since) >= MOVED)
      return { ok: !moved, seen: moved ? `${moved.label} moved ${num(movedAfter(moved, since))} after the text changed at ${num(since)} s` : `${tracks[0]!.label} did not move after the text changed at ${num(since)} s` }
    },
  },
  {
    pattern: /^(?:no more|no new|not one|zero|no) (.+?) (?:appears?|appeared|spawns?|spawned|is created)(?= after| once| since| when)/i,
    check: (m, outcome) => {
      if (!AFTER_TEXT.test(clean(m.input!))) return "not one of the forms at the end of PLAN.md"
      const since = textChangedAt(outcome)
      if (since === null) return { ok: false, seen: `the text on screen never changed (it was "${outcome.run.hud[1]}")` }
      const wanted = m[1]!.trim().toLowerCase()
      const later = outcome.run.objects.filter((o) => o.added !== null && o.added > since + 0.05 && (o.label.toLowerCase() === wanted || o.label.toLowerCase().startsWith(wanted)))
      return { ok: later.length === 0, seen: later.length === 0 ? `nothing named ${m[1]!.trim()} appeared after the text changed at ${num(since)} s` : `${later.length} named ${m[1]!.trim()} appeared after the text changed at ${num(since)} s, the last at ${num(Math.max(...later.map((o) => o.added!)))} s` }
    },
  },
  {
    pattern: /^(?:nothing|no object|the game|game|everything|all objects) (?:moves?|moved|stops?|stopped|freezes?|froze|stands still|is still)(?= after| once| since| when)/i,
    check: (m, outcome) => {
      if (!AFTER_TEXT.test(clean(m.input!))) return "not one of the forms at the end of PLAN.md"
      const since = textChangedAt(outcome)
      if (since === null) return { ok: false, seen: `the text on screen never changed (it was "${outcome.run.hud[1]}")` }
      const moving = outcome.run.objects.filter((o) => !o.camera && o.start && movedAfter(o, since) >= MOVED)
      const appeared = outcome.run.objects.filter((o) => o.added !== null && o.added > since + 0.05)
      const ok = moving.length === 0 && appeared.length === 0
      const seen = ok
        ? `nothing moved or appeared after the text changed at ${num(since)} s`
        : `after the text changed at ${num(since)} s: ${moving.slice(0, 3).map((o) => `${o.label} moved ${num(movedAfter(o, since))}`).join(", ")}${appeared.length > 0 ? `${moving.length > 0 ? "; " : ""}${appeared.length} object(s) appeared` : ""}`
      return { ok, seen }
    },
  },
  {
    pattern: /^no errors?$/i,
    check: (_m, outcome) => {
      const found = problems(outcome)
      return { ok: found.length === 0, seen: found.length === 0 ? "no errors" : `${found.length} error(s): ${found[0]!.text}` }
    },
  },
  {
    pattern: /^(?:the )?text (?:does not|doesn't|did not|didn't) (?:contain|include|show|say) (.+)$/i,
    check: (m, outcome) => ({ ok: !outcome.run.hud[1].includes(unquote(m[1]!)), seen: `text was "${outcome.run.hud[1]}"` }),
  },
  {
    pattern: /^(?:the )?text (?:contains|includes|shows|says|has) (.+)$/i,
    check: (m, outcome) => ({ ok: outcome.run.hud[1].includes(unquote(m[1]!)), seen: `text was "${outcome.run.hud[1]}"` }),
  },
  {
    pattern: /^(?:the )?text (?:is|=|equals|reads) (.+)$/i,
    check: (m, outcome) => ({ ok: outcome.run.hud[1].trim() === unquote(m[1]!), seen: `text was "${outcome.run.hud[1]}"` }),
  },
  {
    pattern: /^(.+?) (?:moves?|moved|goes|went|swings?) (?:back and forth|forth and back|to and fro|left and right|right and left|up and down|down and up)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const hit = tracks.find((o) => [0, 1, 2].some((axis) => wentTowards(o, axis, 1) && wentTowards(o, axis, -1)))
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: hit ? `${one.label} went both ways, ${num(one.far)} from where it started at most` : `${one.label} went from ${point(one.start!)} to ${point(one.end!)} one way` }
    },
  },
  {
    pattern: /^(.+?) (?:moves?|moved|goes|went) (right|left|up|down|forwards?|back|backwards?)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const [axis, sign, words] = DIRECTIONS[m[2]!.toLowerCase()]!
      const hit = tracks.find((o) => wentTowards(o, axis, sign))
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: `${one.label} went from ${point(one.start!)} to ${point(one.end!)}${hit ? ` (${words})` : ""}` }
    },
  },
  {
    pattern: /^(.+?) (?:falls?|fell|drops?|dropped)(?: (?:into|in|down|through) .+)?$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const hit = tracks.find((o) => lowestY(o) < o.start![1] - 1)
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: `${one.label} started at y ${num(one.start![1])} and got down to y ${num(lowestY(one))}` }
    },
  },
  {
    pattern: /^(.+?) (?:is|was|gets|got) (?:reset|respawned|teleported|put back)$|^(.+?) (?:respawns?|respawned|teleports?|teleported|resets?)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1] ?? m[2]!, outcome)
      if (typeof tracks === "string") return tracks
      let when: number | null = null
      const hit = tracks.find((o) => (when = teleported(o)) !== null)
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: hit ? `${one.label} jumped to another position at ${num(when!)} s, ending at ${point(one.end!)}` : `${one.label} never jumped position; it ended at ${point(one.end!)}` }
    },
  },
  {
    pattern: /^(.+?) (?:ends?(?: up)?|is|was|stays?) (?:at|in) \(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const target: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])]
      const hit = tracks.find((o) => Math.hypot(o.end![0] - target[0], o.end![1] - target[1], o.end![2] - target[2]) < 0.3)
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: `${one.label} ended at ${point(one.end!)}` }
    },
  },
  {
    pattern: /^(.+?) (?:does not|doesn't|did not|didn't|never) moves?$|^(.+?) (?:stays?|stayed|remains?|is) (?:still|put|in place|where it (?:is|was))$/i,
    check: (m, outcome) => {
      const tracks = named(m[1] ?? m[2]!, outcome)
      if (typeof tracks === "string") return tracks
      const moved = tracks.find((o) => o.far >= MOVED)
      return { ok: !moved, seen: moved ? `${moved.label} moved ${num(moved.far)}` : `${tracks[0]!.label} did not move` }
    },
  },
  {
    pattern: /^(.+?) (?:moves?|moved|is moving)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const hit = tracks.find((o) => o.far >= MOVED)
      return { ok: Boolean(hit), seen: hit ? `${hit.label} moved ${num(hit.far)}` : `${tracks[0]!.label} did not move` }
    },
  },
  {
    pattern: /^(.+?) jumps?(?:ed)?(?: (\d+|once|twice) times?| (once|twice))?$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const word = (m[2] ?? m[3] ?? "").toLowerCase()
      const wanted = word === "" ? null : word === "once" ? 1 : word === "twice" ? 2 : Number(word)
      const best = tracks.reduce((a, b) => ((b.pushedUp?.length ?? 0) > (a.pushedUp?.length ?? 0) ? b : a))
      const count = best.pushedUp?.length ?? 0
      return { ok: wanted === null ? count >= 1 : count === wanted, seen: `${best.label} was pushed upward ${count} time(s), rose ${num(best.rose)}` }
    },
  },
  {
    pattern: /^(.+?) (?:rises?|rose|goes up|went up)(?: (?:at least|more than|over|by) ([\d.]+))?$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const least = m[2] ? Number(m[2]) : 0.2
      const best = tracks.reduce((a, b) => (b.rose > a.rose ? b : a))
      return { ok: best.rose >= least, seen: `${best.label} rose ${num(best.rose)}` }
    },
  },
  {
    pattern: /^(.+?) (?:is|was|gets|got) (?:removed|destroyed|deleted|collected)$|^(.+?) (?:disappears?|disappeared|vanishes|vanished)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1] ?? m[2]!, outcome)
      if (typeof tracks === "string") return tracks
      const gone = tracks.find((o) => o.removed !== null)
      return { ok: Boolean(gone), seen: gone ? `${gone.label} was removed at ${num(gone.removed!)} s` : `${tracks[0]!.label} was still there at the end` }
    },
  },
  {
    pattern: /^(.+?) (?:appears?|appeared|spawns?|spawned|is created|are created)(?: (\d+|once|twice) times?| (once|twice))?$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      const word = (m[2] ?? m[3] ?? "").toLowerCase()
      const wanted = word === "" ? null : word === "once" ? 1 : word === "twice" ? 2 : Number(word)
      if (typeof tracks === "string") return { ok: false, seen: `nothing named ${m[1]!.trim()} appeared` }
      const count = tracks.filter((o) => o.added !== null).length
      return { ok: wanted === null ? count >= 1 : count === wanted, seen: `${count} appeared during the play` }
    },
  },
  {
    pattern: /^(.+?) (?:changes?|changed) colou?r$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const hit = tracks.find((o) => o.color && o.color[0] !== o.color[1])
      return { ok: Boolean(hit), seen: hit ? `${hit.label} went from #${hit.color![0]} to #${hit.color![1]}` : `${tracks[0]!.label} kept its colour${tracks[0]!.color ? ` (#${tracks[0]!.color[1]})` : ""}` }
    },
  },
  {
    pattern: /^(.+?) (?:turns?|turned|becomes?|became|is|ends?(?: up)?) (red|orange|yellow|green|cyan|blue|purple|pink|white|gray|grey|black|brown|#?[0-9a-f]{6})$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const wanted = m[2]!.toLowerCase().replace("grey", "gray").replace(/^#/, "")
      const hit = tracks.find((o) => o.color && (o.color[1] === wanted || colorName(o.color[1]) === wanted))
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: one.color ? `${one.label} ended ${colorName(one.color[1])} (#${one.color[1]})` : `${one.label} has no colour` }
    },
  },
  {
    pattern: /^(.+?)(?: ends?(?: up)?| is| was)?(?: at)? ([xyz])\s*(>=|<=|==|=|>|<|is|over|above|under|below)\s*(-?[\d.]+)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const axis = { x: 0, y: 1, z: 2 }[m[2]!.toLowerCase()]!
      const op = m[3]!.toLowerCase()
      const value = Number(m[4])
      const test = (v: number) =>
        op === ">" || op === "over" || op === "above" ? v > value : op === "<" || op === "under" || op === "below" ? v < value : op === ">=" ? v >= value : op === "<=" ? v <= value : Math.abs(v - value) < 0.15
      const hit = tracks.find((o) => test(o.end![axis]!))
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: `${one.label} ended at ${m[2]!.toLowerCase()} ${num(one.end![axis]!)}` }
    },
  },
  {
    pattern: /^(.+?) (?:is|was|stays?|ends?(?: up)?) (on|off)[ -]?screen$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const want = m[2]!.toLowerCase() === "on"
      const hit = tracks.find((o) => o.onScreen === want)
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: `${one.label} ended ${one.onScreen === null ? "with no camera to judge" : one.onScreen ? "on screen" : "off screen"}` }
    },
  },
  {
    pattern: /^(.+?) (?:is|was|stays?|stands?|ends?(?: up)?|lands?|landed|rides?) (?:above|on|on top of|over|onto) (?:the )?(.+)$/i,
    check: (m, outcome) => {
      const tracks = named(m[1]!, outcome)
      if (typeof tracks === "string") return tracks
      const under = named(m[2]!, outcome)
      if (typeof under === "string") return under
      const base = under[0]!
      const hit = tracks.find((o) => o.end![1] > base.end![1] && Math.hypot(o.end![0] - base.end![0], o.end![2] - base.end![2]) < 2.5)
      const one = hit ?? tracks[0]!
      return { ok: Boolean(hit), seen: `${one.label} ended at ${point(one.end!)}, ${base.label} at ${point(base.end!)}` }
    },
  },
]

const clean = (expect: string) => expect.trim().replace(/[.;]+$/, "").replace(/^(?:the|a|an) /i, "")

export const understood = (expect: string) => RULES.some((rule) => rule.pattern.test(clean(expect)))

/** One Expect line against what a test play showed. `ok` null: the line is not a known form. */
export function checkExpectation(expect: string, outcome: Outcome): Verdict {
  const text = clean(expect)
  for (const rule of RULES) {
    const match = rule.pattern.exec(text)
    if (!match) continue
    const result = rule.check(match, outcome)
    return typeof result === "string" ? { expect, ok: false, seen: result } : { expect, ...result }
  }
  return { expect, ok: null, seen: "not one of the forms at the end of PLAN.md" }
}

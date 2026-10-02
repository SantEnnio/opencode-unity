// What the probe saw in the page, reduced to a few lines a small model can act on. The raw
// recording never reaches the model.

export type PageEvent = { kind: "error" | "warn" | "exception" | "load"; text: string; where: string; count: number; first: number }

type Point = [number, number, number]
export type Track = {
  label: string
  start: Point | null
  end: Point | null
  /** Farthest it got from where it started, and how far above its start it rose */
  far: number
  rose: number
  /** Seconds into the play of each sudden gain of upward speed: a jump, a bounce, a launch */
  pushedUp?: number[]
  /** Seconds into the play when it appeared or went away; null when it was there all along */
  added: number | null
  removed: number | null
  onScreen: boolean | null
  camera?: boolean
}

export type PageRun = {
  id: string
  page: string
  seconds: number
  /** Frames three.js drew during the play, and frames the browser offered */
  frames: number
  rafFrames: number
  visible: boolean
  three: string | null
  drawn: boolean
  calls: number | null
  pixels: { flat: boolean; color: string } | null
  hud: [string, string]
  /** Seconds into the play when the text on screen last changed */
  hudChanged?: number | null
  events: PageEvent[]
  objects: Track[]
}

/** What the user's own tab says while they play. */
export type TabReport = { seconds: number; frames: number; visible: boolean; events: PageEvent[] }

export type Outcome = {
  run: PageRun
  /** Files the page asked for that are not in the prototype */
  missing: string[]
  /** The key script as it was played, and for how long keys were held */
  keys: string | null
  held: number
  /** A browser with no window, or the user's own tab */
  ranIn: "headless" | "tab"
  /** three.js names the prototype's files use that do not exist: found by reading, not by running */
  unknown?: { file: string; line: number; name: string; instead: string }[]
  /** The known fix for an error message, when there is one */
  fixFor?: (text: string) => string | null
}

const num = (n: number) => {
  const text = (Math.round(n * 10) / 10).toFixed(1)
  return text === "-0.0" ? "0.0" : text
}
const secs = (n: number) => `${num(n)} s`
const point = (p: Point) => `(${p.map(num).join(", ")})`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const MOVED = 0.05

type Problem = { text: string; where: string; fix?: string | null }

/** Everything that makes the page wrong: errors, exceptions, files that are not there. Warnings are not. */
export function problems(outcome: Outcome): Problem[] {
  const found: Problem[] = []
  const named = new Set<string>()
  for (const file of outcome.missing) {
    named.add(file)
    found.push({ text: `${file} does not exist, but the page loads or imports it`, where: "", fix: `create ${file}, or remove the line that loads it.` })
  }
  const reported = new Set<string>()
  for (const event of outcome.run.events) {
    if (event.kind === "warn") continue
    // A script that "could not load" because a file it imports is missing: the missing file is the news.
    if (event.kind === "load" && named.size > 0) continue
    if (event.kind === "error" && /Failed to load resource/.test(event.text)) continue
    const times = event.count > 1 ? ` (${event.count}×)` : ""
    if (event.where) reported.add(event.where)
    found.push({ text: `${event.where ? `${event.where}: ` : ""}${event.text}${times}`, where: event.where, fix: outcome.fixFor?.(event.text) })
  }
  // A wrong name on a line that did not run yet is still wrong.
  for (const u of outcome.unknown ?? []) {
    const where = `${u.file}:${u.line}`
    if (reported.has(where)) continue
    found.push({ text: `${where}: THREE.${u.name} does not exist`, where, fix: `three.js has no ${u.name}: ${u.instead}.` })
  }
  return found
}

const listed = (p: Problem) => (p.fix ? [`- ${p.text}`, `  FIX: ${p.fix}`] : [`- ${p.text}`])

const warnings = (run: PageRun) => run.events.filter((event) => event.kind === "warn")

/** The game did not run at all: nothing about its behaviour can be said. */
const neverDrew = (run: PageRun) => run.frames === 0

/** The closing pointer: the line to fix when one is known, then what happens or what to call. */
function nextFor(found: Problem[], then: string): string {
  const where = found.find((p) => p.where)?.where
  if (!where) return `→ Next: fix ${found.length === 1 ? "this" : "these"}. ${then}`
  const [file, line] = where.split(":")
  return `→ Next: fix ${file}${line ? ` line ${line}` : ""}. ${then}`
}

const CHECKED_AGAIN = "The page is checked again when you edit it."
const PLAY_AGAIN = "Then call proto_play again."

function notDrawn(run: PageRun): string {
  if (!run.visible) return "The browser tab was in the background, so the page did not run."
  if (!run.drawn) return "The page loaded but three.js never drew a frame: nothing calls game.run(...) or renderer.render(scene, camera)."
  return "The page loaded but did not draw a single frame."
}

function emptyScreen(run: PageRun): string | null {
  if (!run.pixels?.flat) return null
  const seen = run.objects.some((o) => !o.camera && o.removed === null && o.onScreen)
  return seen
    ? "The screen is one flat color although objects are in front of the camera: check their materials and the lights."
    : "Nothing is visible: the screen is one flat color and no object is in front of the camera. Check the camera position and that objects are added to the scene."
}

/**
 * The note that goes with the user's next message when their own tab showed errors while they
 * tried the game. Null when there is nothing to say. It is added to one request, never stored.
 */
export function tabNote(name: string, tab: TabReport, fixFor?: (text: string) => string | null): string | null {
  const errors = tab.events.filter((event) => event.kind !== "warn" && !(event.kind === "error" && /Failed to load resource/.test(event.text)))
  if (errors.length === 0) return null
  // Says where it comes from: a small model otherwise takes it for text the user pasted.
  const lines = [`[proto] Recorded by the plugin in the user's browser tab while they tried "${name}": ${plural(errors.length, "error")}.`]
  for (const event of errors.slice(0, 3)) {
    lines.push(`- ${event.where ? `${event.where}: ` : ""}${event.text}${event.count > 1 ? ` (${event.count}×)` : ""}`)
    const fix = fixFor?.(event.text)
    if (fix) lines.push(`  FIX: ${fix}`)
  }
  if (errors.length > 3) lines.push(`- and ${errors.length - 3} more`)
  lines.push("→ Fix these before anything else.")
  return lines.join("\n")
}

/** The page check that follows an edit: did it load and draw, with which errors. */
export function checkReport(name: string, outcome: Outcome): { failing: boolean; report: string } {
  const { run } = outcome
  const found = problems(outcome)
  if (found.length > 0) {
    const lines = [`[proto] Page check FAILED: "${name}" has ${plural(found.length, "error")}.`, ...found.slice(0, 6).flatMap(listed)]
    if (found.length > 6) lines.push(`- and ${found.length - 6} more`)
    lines.push(nextFor(found, CHECKED_AGAIN))
    return { failing: true, report: lines.join("\n") }
  }
  if (neverDrew(run)) {
    if (!run.visible) return { failing: false, report: `[proto] Page NOT checked: ${notDrawn(run)} Ask the user to bring the tab with "${name}" to the front.` }
    return { failing: true, report: `[proto] Page check FAILED: ${notDrawn(run)}\n→ Next: fix this in main.js. ${CHECKED_AGAIN}` }
  }
  const lines = [`[proto] Page check passed: "${name}" loaded and drew ${plural(run.frames, "frame")} with no errors.`]
  const empty = emptyScreen(run)
  if (empty) lines.push(`- ${empty}`)
  for (const warning of warnings(run).slice(0, 3)) lines.push(`- Warning: ${warning.where ? `${warning.where}: ` : ""}${warning.text}`)
  return { failing: false, report: lines.join("\n") }
}

function movement(outcome: Outcome): string[] {
  const { run } = outcome
  const lines: string[] = []
  const here = run.objects.filter((o) => o.start && o.end)
  const moved = here.filter((o) => o.far >= MOVED && o.added === null).sort((a, b) => b.far - a.far)
  for (const o of moved.slice(0, 6)) {
    const ups = o.pushedUp ?? []
    const pushed = ups.length === 0 ? "" : `, pushed upward ${ups.length === 1 ? "once" : `${ups.length} times`} (at ${ups.map(secs).join(", ")})`
    const rose = o.rose >= 0.2 ? `, rose ${num(o.rose)}${pushed}` : ""
    const gone = o.removed !== null ? `, removed at ${secs(o.removed)}` : o.onScreen === false && !o.camera ? ", ended off screen" : ""
    // Out and back (a jump, right then left) is not the same as ending far away.
    const ended = Math.hypot(o.end![0] - o.start![0], o.end![1] - o.start![1], o.end![2] - o.start![2])
    const path =
      ended < MOVED
        ? `moved ${num(o.far)} away from ${point(o.start!)} and came back`
        : o.far - ended > 0.2
          ? `moved ${num(o.far)} away from ${point(o.start!)} and ended at ${point(o.end!)}`
          : `moved ${num(o.far)}: ${point(o.start!)} → ${point(o.end!)}`
    lines.push(`- ${o.label} ${path}${rose}${gone}`)
  }
  if (moved.length > 6) lines.push(`- and ${moved.length - 6} more objects moved`)

  const removed = here.filter((o) => o.removed !== null && o.far < MOVED && o.added === null)
  for (const o of removed.slice(0, 4)) lines.push(`- ${o.label} was removed at ${secs(o.removed!)}`)
  const added = here.filter((o) => o.added !== null)
  // Bullets, enemies, coins: many objects under one name are one line, not one each.
  const groups = new Map<string, Track[]>()
  for (const o of added) groups.set(o.label, [...(groups.get(o.label) ?? []), o])
  for (const [label, group] of [...groups].slice(0, 4)) {
    const first = group[0]!
    const removed = group.filter((o) => o.removed !== null)
    if (group.length === 1) {
      const after = `${first.far >= MOVED ? `, moved ${num(first.far)}` : ""}${first.removed !== null ? `, removed at ${secs(first.removed)}` : ""}`
      lines.push(`- ${label} appeared at ${secs(first.added!)} at ${point(first.start!)}${after}`)
      continue
    }
    const far = Math.max(...group.map((o) => o.far))
    const gone = removed.length === 0 ? "" : removed.length === group.length ? "; all were removed" : `; ${removed.length} were removed`
    const lastAt = Math.max(...group.map((o) => o.added!))
    lines.push(`- ${group.length} objects named ${label} appeared, the first at ${secs(first.added!)} at ${point(first.start!)}, the last at ${secs(lastAt)}${far >= MOVED ? `; they moved up to ${num(far)}` : ""}${gone}`)
  }
  if (groups.size > 4) lines.push(`- and ${groups.size - 4} more kinds of objects appeared`)

  if (run.hud[0] !== run.hud[1]) lines.push(`- Text on screen: "${run.hud[0]}" → "${run.hud[1]}"${typeof run.hudChanged === "number" ? ` (at ${secs(run.hudChanged)})` : ""}`)
  else if (run.hud[1]) lines.push(`- Text on screen: "${run.hud[1]}" (did not change)`)

  const still = here.filter((o) => o.far < MOVED && o.removed === null && o.added === null && !o.camera)
  if (moved.filter((o) => !o.camera).length === 0 && added.length === 0 && removed.length === 0 && still.length > 0) {
    // Which object the keys should move is unknown: only "nothing moved at all" is a finding.
    lines.unshift(outcome.held >= 0.5 ? `- Keys were held for ${secs(outcome.held)} and nothing moved.` : "- Nothing moved.")
  } else if (still.length > 0) {
    const names = still.slice(0, 5).map((o) => o.label).join(", ")
    lines.push(`- Did not move: ${names}${still.length > 5 ? `, and ${still.length - 5} more` : ""}`)
  }
  return lines
}

/** What a test play showed: errors first, then what moved, appeared, went away, and the text on screen. */
export function playReport(name: string, outcome: Outcome): { failing: boolean; report: string } {
  const { run } = outcome
  const found = problems(outcome)
  const input = outcome.keys ? `keys "${outcome.keys}"` : "no keys"
  const head = `[proto] Test play of "${name}": ${secs(run.seconds)}, ${plural(run.frames, "frame")}, ${input}.`

  if (neverDrew(run) && found.length === 0) {
    if (!run.visible) return { failing: false, report: `[proto] Game NOT tested: ${notDrawn(run)} Ask the user to bring the tab with "${name}" to the front, then call proto_play again.` }
    return { failing: true, report: `[proto] Game NOT tested: ${notDrawn(run)}\n→ Next: fix this in main.js. ${PLAY_AGAIN}` }
  }

  const lines = [found.length > 0 ? `${head} FAILED, ${plural(found.length, "error")}:` : `${head} No errors.`]
  lines.push(...found.slice(0, 6).flatMap(listed))
  if (found.length > 6) lines.push(`- and ${found.length - 6} more`)
  // The kit's loop ends at the first error inside it: say so, or "nothing moved" reads as a second bug.
  const thrown = run.events.find((event) => event.kind === "exception")
  if (thrown && !neverDrew(run) && run.frames < run.rafFrames * 0.6) lines.push(`- The game stopped at ${secs(thrown.first)}: the error is inside the game loop, which ends there.`)
  if (found.length > 0 && !neverDrew(run)) lines.push("What happened before the error:")
  if (!neverDrew(run)) {
    const empty = emptyScreen(run)
    if (empty) lines.push(`- ${empty}`)
    lines.push(...movement(outcome))
  }
  if (found.length === 0) for (const warning of warnings(run).slice(0, 3)) lines.push(`- Warning: ${warning.where ? `${warning.where}: ` : ""}${warning.text}`)
  lines.push(
    found.length > 0
      ? nextFor(found, PLAY_AGAIN)
      : "→ Next: if this is what the step should do, go on to the next step. If not, change the code and call proto_play again.",
  )
  return { failing: found.length > 0, report: lines.join("\n") }
}

// Reads what the runtime probe recorded (Library/OpencodeUnity/probe/last-run.json) and reduces it
// to a fixed number of lines. The raw recording never reaches the model: a small context cannot
// take a stream, and a truncated stream hides exactly the absences that matter ("never moved").

import fs from "node:fs"
import path from "node:path"

export type ProbeSample = [number, number | null, number | null, number | null, number | null, number | null, number | null, number]

export type ProbeRun = {
  version: number
  id: string
  /** "agent" when unity_play started it (older recordings lack it: the user) */
  startedBy?: "agent" | "user"
  requestId?: string | null
  /** The key script of a test play, as it was run */
  input?: string | null
  endedAt: string
  unity: string
  scene: string
  gameTime: number
  realTime: number
  frames: number
  unfocusedTime: number
  /** Real seconds spent paused, and the game time of the first pause (older recordings lack them) */
  pausedTime?: number
  pausedAt?: number | null
  lowestStatic: number | null
  inputSystem: boolean
  logs: { kind: string; message: string; where: string; count: number; first: number }[]
  objects: { path: string; body: string; dynamic: boolean; spawned: number | null; destroyed: number | null; samples: ProbeSample[] }[]
  contacts: { a: string; b: string; count: number; first: number }[]
  keys: { key: string; count: number; first: number; held: number }[]
  actions: { action: string; count: number; first: number }[]
}

export const probeDir = (projectRoot: string) => path.join(projectRoot, "Library", "OpencodeUnity", "probe")

/** The last recorded run, or null when there is none or it cannot be read. */
export function readRun(projectRoot: string): ProbeRun | null {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(probeDir(projectRoot), "last-run.json"), "utf8")) as ProbeRun
    return run.version === 1 && Array.isArray(run.objects) ? run : null
  } catch {
    return null
  }
}

const num = (n: number) => {
  const text = (Math.round(n * 10) / 10).toFixed(1)
  return text === "-0.0" ? "0.0" : text
}
const secs = (n: number) => `${num(n)} s`
const vec = (s: ProbeSample) => `(${[s[1], s[2], s[3]].map((v) => (v === null ? "NaN" : num(v))).join(", ")})`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * A game that did not advance says nothing about behaviour: Unity was in the background. Unless it
 * stopped on an error: an error in the first frame pauses the game at once (Error Pause), and that
 * is the finding, not a window to bring to the front.
 */
export const ran = (run: ProbeRun) => (run.frames >= 10 && run.gameTime >= 0.2) || run.logs.length > 0 || (run.pausedTime ?? 0) >= 0.5

const distance = (a: ProbeSample, b: ProbeSample) => Math.hypot((b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0), (b[3] ?? 0) - (a[3] ?? 0))
const valid = (s: ProbeSample) => s[1] !== null && s[2] !== null && s[3] !== null

type Finding = { rank: number; text: string; object?: string }

/** How far an object got from where it started, and how far above its start it rose. */
function travel(samples: ProbeSample[]): { moved: number; rose: number } {
  const good = samples.filter(valid)
  const start = good[0]
  if (!start) return { moved: 0, rose: 0 }
  return {
    moved: Math.max(0, ...good.map((s) => distance(start, s))),
    rose: Math.max(0, ...good.map((s) => (s[2] ?? 0) - (start[2] ?? 0))),
  }
}

function objectFindings(run: ProbeRun): Finding[] {
  const heldTime = run.keys.reduce((sum, k) => sum + k.held, 0)
  const findings: Finding[] = []
  // Which object the keys should move is unknown: only "nothing moved at all" is a finding. Seen
  // with two players, one driven by Space: the other was reported as never moving.
  const dynamic = run.objects.filter((o) => o.dynamic && o.destroyed === null && o.samples.some(valid))
  if (heldTime >= 0.5 && dynamic.length > 0 && dynamic.every((o) => travel(o.samples).moved < 0.05)) {
    const names = dynamic.slice(0, 3).map((o) => o.path).join(", ")
    findings.push({ rank: 2, text: `Keys were held for ${secs(heldTime)} and nothing moved (${names}${dynamic.length > 3 ? ", ..." : ""})`, object: dynamic[0]!.path })
  }
  for (const o of run.objects) {
    const samples = o.samples
    const bad = samples.find((s) => !valid(s))
    if (bad) findings.push({ rank: 1, text: `${o.path}: position became invalid (NaN) at ${secs(bad[0])}`, object: o.path })
    if (run.lowestStatic !== null) {
      const fell = samples.find((s) => s[2] !== null && s[2] < run.lowestStatic! - 2)
      if (fell) findings.push({ rank: 1, text: `${o.path} fell below the lowest floor (y ${num(run.lowestStatic)}) at ${secs(fell[0])}`, object: o.path })
    }
    if (o.destroyed !== null && o.spawned === null) findings.push({ rank: 3, text: `${o.path} was destroyed at ${secs(o.destroyed)}`, object: o.path })
  }
  return findings
}

function pauseFindings(run: ProbeRun): Finding[] {
  if (!run.pausedTime || run.pausedTime < 0.5) return []
  const why = run.logs.length > 0 ? ": Unity pauses on the first error when Error Pause is on in the Console" : ""
  return [{ rank: 0, text: `The game was paused at ${secs(run.pausedAt ?? 0)} for ${secs(run.pausedTime)}${why}` }]
}

function logFindings(run: ProbeRun): Finding[] {
  return [...run.logs]
    .sort((a, b) => (a.kind === "Error" ? 1 : 0) - (b.kind === "Error" ? 1 : 0) || b.count - a.count)
    .map((l) => {
      const where = l.where.replace(/\s*\(at\s+/, " (").replace(/\s*\[0x[0-9a-f]+\]/i, "")
      const text = l.message.startsWith(`${l.kind}:`) ? l.message.slice(l.kind.length + 1).trim() : l.message
      const message = text.length > 90 ? `${text.slice(0, 90)}...` : text
      return { rank: 0, text: `${l.kind === "Error" ? "Error" : l.kind}${where ? ` in ${where}` : ""}, ${l.count}×, first at ${secs(l.first)}: ${message}` }
    })
}

function inputLine(run: ProbeRun): string | null {
  if (run.keys.length === 0 && run.actions.length === 0) return null
  const keys = [...run.keys]
    .sort((a, b) => b.held - a.held)
    .slice(0, 5)
    .map((k) => (k.held >= 0.3 ? `${k.key} held ${secs(k.held)}` : `${k.key} ×${k.count}`))
  const actions = [...run.actions].sort((a, b) => b.count - a.count).slice(0, 5).map((a) => `${a.action} ×${a.count}`)
  const actionText = actions.length > 0 ? `Actions: ${actions.join(", ")}` : run.inputSystem ? "No Input System action fired" : ""
  return `Input: ${keys.length > 0 ? keys.join(", ") : "no keys"}${actionText ? `. ${actionText}` : ""}`
}

const header = (run: ProbeRun) => {
  if (run.startedBy !== "agent") return `Last play ${secs(run.gameTime)}, ${plural(run.frames, "frame")}`
  if (!run.input) return `Test play ${secs(run.gameTime)} with no input, ${plural(run.frames, "frame")}`
  const pressed = run.inputSystem ? "" : " (NOT pressed: the project has no Input System package)"
  return `Test play ${secs(run.gameTime)} with keys "${run.input}"${pressed}, ${plural(run.frames, "frame")}`
}
const NOT_RUN = (run: ProbeRun) =>
  `[unity] Last play: the game did not run (${plural(run.frames, "frame")} in ${secs(run.realTime)}). Unity was probably in the background: bring its window to the front and press Play again.`

/** Worth telling the model without being asked: something went wrong, or the game did not run. */
export function notable(run: ProbeRun): boolean {
  return !ran(run) || run.logs.length > 0 || pauseFindings(run).length > 0 || objectFindings(run).some((f) => f.rank <= 2)
}

/**
 * The note that goes with the user's next message after a play: at most five lines, one when
 * nothing happened. It is added to one request only, never stored.
 */
export function playNote(run: ProbeRun): string {
  // Says where it comes from: a small model otherwise takes it for text the user pasted.
  const from = "[unity] Recorded by the runtime probe while the user played."
  if (!ran(run)) return NOT_RUN(run).replace("[unity]", from)
  const findings = [...logFindings(run), ...pauseFindings(run), ...objectFindings(run)].sort((a, b) => a.rank - b.rank)
  if (!notable(run)) return `${from} ${header(run)}: no errors, nothing unusual. Details: unity_play.`
  const serious = findings.filter((f) => f.rank <= 2)
  const lines = [`${from} ${header(run)}: ${plural(serious.length, "problem")}.`]
  lines.push(...serious.slice(0, 3).map((f) => `- ${f.text}`))
  const target = findings.find((f) => f.object)?.object
  const timeline = target ? `unity_play path "${target}" shows its timeline.` : "unity_play shows the whole run."
  lines.push(run.logs.length > 0 ? `→ unity_console shows the stack traces; ${timeline}` : `→ ${timeline}`)
  return lines.join("\n")
}

/** unity_play without a path: the whole run, at most about twelve lines. */
export function runReport(run: ProbeRun): string {
  if (!ran(run)) return NOT_RUN(run)
  const findings = [...logFindings(run), ...pauseFindings(run), ...objectFindings(run)].sort((a, b) => a.rank - b.rank)
  const lines = [`[unity] ${header(run)}${run.scene ? ` in ${run.scene}` : ""}. ${findings.length === 0 ? "No errors, nothing unusual." : `${plural(findings.length, "problem")}:`}`]
  lines.push(...findings.slice(0, 5).map((f) => `- ${f.text}`))
  for (const o of run.objects.slice(0, 6)) {
    const good = o.samples.filter(valid)
    if (good.length === 0) continue
    const first = good[0]!
    const last = good.at(-1)!
    const moved = distance(first, last)
    const top = Math.max(0, ...good.map((s) => Math.hypot(s[4] ?? 0, s[5] ?? 0, s[6] ?? 0)))
    const peak = Math.max(...good.map((s) => s[2] ?? -Infinity))
    const rose = peak - Math.max(first[2] ?? 0, last[2] ?? 0)
    const path = moved < 0.05 ? (rose >= 0.2 ? `went up to y ${num(peak)} and came back to ${vec(last)}` : `stayed at ${vec(first)}`) : `${vec(first)} → ${vec(last)}${rose >= 0.2 ? `, highest y ${num(peak)}` : ""}`
    lines.push(`${o.path}: ${path}${top >= 0.1 ? `, top speed ${num(top)} m/s` : ""}`)
  }
  const input = inputLine(run)
  if (input) lines.push(input)
  const contacts = [...run.contacts].sort((a, b) => a.first - b.first).slice(0, 3)
  if (contacts.length > 0) lines.push(`Collisions: ${contacts.map((c) => `${c.a} ↔ ${c.b} at ${secs(c.first)}`).join(", ")}`)
  const target = findings.find((f) => f.object)?.object ?? run.objects[0]?.path
  if (target) lines.push(`→ unity_play path "${target}" shows its timeline.`)
  return lines.join("\n")
}

/** Positions over time for one object, as at most about ten segments. */
export function objectTimeline(run: ProbeRun, wanted: string): string {
  const key = wanted.trim().replace(/\/+$/, "")
  const object =
    run.objects.find((o) => o.path === key || o.path === `/${key.replace(/^\/+/, "")}`) ??
    run.objects.find((o) => o.path.toLowerCase().endsWith(`/${key.replace(/^\/+/, "").toLowerCase()}`))
  if (!object) {
    return `[unity] '${wanted}' was not recorded in the last play. Recorded: ${run.objects.map((o) => o.path).join(", ") || "nothing"}. Objects are recorded when they have a Rigidbody or a CharacterController, or when you created or changed them with the scene tools.`
  }
  const good = object.samples.filter(valid)
  const lines = [
    `[unity] ${object.path} (${object.body === "none" ? "no Rigidbody" : object.body}${object.dynamic ? "" : ", not moved by physics"}) in the last play, ${secs(run.gameTime)}:`,
  ]
  if (object.spawned !== null) lines.push(`- appeared at ${secs(object.spawned)}`)

  // Segments: runs of samples that are all moving or all still.
  type Segment = { moving: boolean; from: ProbeSample; to: ProbeSample; top: number; peak: number }
  const segments: Segment[] = []
  for (let i = 1; i < good.length; i++) {
    const a = good[i - 1]!
    const b = good[i]!
    const dt = Math.max(1e-3, b[0] - a[0])
    const moving = distance(a, b) / dt > 0.1
    const speed = Math.hypot(b[4] ?? 0, b[5] ?? 0, b[6] ?? 0)
    const last = segments.at(-1)
    const y = Math.max(a[2] ?? -Infinity, b[2] ?? -Infinity)
    if (last && last.moving === moving) (last.to = b), (last.top = Math.max(last.top, speed)), (last.peak = Math.max(last.peak, y))
    else segments.push({ moving, from: a, to: b, top: speed, peak: y })
  }
  // Merge blips shorter than 0.3 s into their neighbours, then the shortest pairs, down to 8.
  const length = (s: Segment) => s.to[0] - s.from[0]
  const merge = (i: number) => {
    const into = segments[i - 1] ?? segments[i + 1]!
    const gone = segments[i]!
    if (into === segments[i - 1]) into.to = gone.to
    else into.from = gone.from
    into.top = Math.max(into.top, gone.top)
    into.peak = Math.max(into.peak, gone.peak)
    into.moving = into.moving || gone.moving
    segments.splice(i, 1)
  }
  for (let i = segments.length - 1; i >= 0 && segments.length > 1; i--) if (length(segments[i]!) < 0.3) merge(i)
  while (segments.length > 8) {
    let shortest = 0
    segments.forEach((s, i) => (length(s) < length(segments[shortest]!) ? (shortest = i) : 0))
    merge(shortest)
  }
  for (const s of segments) {
    const span = `${num(s.from[0])}–${num(s.to[0])} s`
    // A jump starts and ends at the same height: only the highest point shows it.
    const rose = s.peak - Math.max(s.from[2] ?? 0, s.to[2] ?? 0)
    const net = distance(s.from, s.to)
    lines.push(
      !s.moving
        ? `- ${span} still at ${vec(s.to)}`
        : net < 0.05 && rose >= 0.2
          ? `- ${span} went up to y ${num(s.peak)} and came back to ${vec(s.to)}, top speed ${num(s.top)} m/s`
          : `- ${span} moved ${vec(s.from)} → ${vec(s.to)}, ${num(net)} m, top speed ${num(s.top)} m/s${rose >= 0.2 ? `, highest y ${num(s.peak)}` : ""}`,
    )
  }
  if (good.length === 1) lines.push(`- at ${vec(good[0]!)}`)
  const bad = object.samples.find((s) => !valid(s))
  if (bad) lines.push(`- position became invalid (NaN) at ${secs(bad[0])}`)
  if (object.destroyed !== null) lines.push(`- destroyed at ${secs(object.destroyed)}`)
  const touches = run.contacts.filter((c) => c.a === object.path || c.b === object.path).slice(0, 4)
  for (const c of touches) lines.push(`- hit ${c.a === object.path ? c.b : c.a} ${c.count === 1 ? "once" : `${c.count} times`}, first at ${secs(c.first)}`)
  return lines.join("\n")
}

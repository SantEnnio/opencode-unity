// What happened to a prototype, as the plugin saw it: every plan save, blocked write, page check,
// test play and phase test, appended to .proto/journal.jsonl inside the prototype. SESSION.md is
// the readable report built from it. Both travel with the folder, so collecting a student's work
// means collecting the folder, whatever opencode version made it.

import fs from "node:fs"
import path from "node:path"
import { PLAN_FILE } from "./plan.ts"

export type Entry = {
  at: string
  session: string
  event: "new" | "plan" | "blocked" | "check" | "play" | "test" | "lookup" | "export"
  detail: Record<string, unknown>
  text?: string
}

export const JOURNAL_DIR = ".proto"
export const SESSION_FILE = "SESSION.md"

export function journal(prototypeDir: string, entry: Omit<Entry, "at">) {
  try {
    const dir = path.join(prototypeDir, JOURNAL_DIR)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, "journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // a journal that cannot be written must not stop the work
  }
}

export function readJournal(prototypeDir: string): Entry[] {
  try {
    return fs
      .readFileSync(path.join(prototypeDir, JOURNAL_DIR, "journal.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Entry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

const clock = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}
const day = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const firstLine = (text: string | undefined) => (text ?? "").split("\n")[0] ?? ""
const minutes = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000)

function headline(entry: Entry): string {
  const d = entry.detail
  switch (entry.event) {
    case "new":
      return "created"
    case "plan":
      return d.ready ? `plan saved: ready, ${d.phases} phase(s)${Number(d.problems) > 0 ? `, ${d.problems} remark(s)` : ""}` : `plan saved: not ready (${d.problems} problem(s))`
    case "blocked":
      return `write blocked: ${d.file}`
    case "check":
      return `edit ${d.file}: ${d.failing ? "check FAILED" : "check passed"}${d.failing ? ` — ${((entry.text ?? "").split("\n")[1] ?? "").replace(/^- /, "")}` : ""}`
    case "play":
      return `test play${d.keys ? ` "${d.keys}"` : ""}: ${d.failing ? "errors" : "no errors"}`
    case "test": {
      const phases = d.phase ? `phase ${d.phase}` : "all phases"
      const failed = (entry.text ?? "").split("\n").find((line) => /: NO\. /.test(line))
      return `test ${phases}: ${d.passed}/${d.total} passed${failed ? ` — ${failed.replace(/^- /, "")}` : ""}`
    }
    case "lookup":
      return `lookup ${d.query}: ${firstLine(entry.text).replace(/^\[proto\] /, "").slice(0, 100)}`
    case "export":
      return "report written"
  }
}

/** SESSION.md: the plan as it stands, the numbers, the timeline, and every phase test in full. */
export function renderSession(name: string, prototypeDir: string, entries: Entry[], about: { version: string; three: string }): string {
  const plan = (() => {
    try {
      // One level down, so the plan's headings sit under this report's.
      return fs
        .readFileSync(path.join(prototypeDir, PLAN_FILE), "utf8")
        .split(/^## Forms for Expect lines/m)[0]!
        .trim()
        .replace(/^(#{1,5}) /gm, "#$1 ")
    } catch {
      return "(no PLAN.md)"
    }
  })()
  const sessions = new Set(entries.map((e) => e.session))
  const first = entries[0]
  const last = entries[entries.length - 1]
  const count = (event: Entry["event"]) => entries.filter((e) => e.event === event).length
  const tests = entries.filter((e) => e.event === "test")
  const testsPassed = tests.filter((e) => e.detail.passed === e.detail.total).length
  const checks = entries.filter((e) => e.event === "check")
  const checksFailed = checks.filter((e) => e.detail.failing).length
  const days = [...new Set(entries.map((e) => day(e.at)))]

  const lines = [
    `# ${name}: session report`,
    "",
    `Written by opencode-game-prototype ${about.version} (three.js ${about.three}) on ${day(new Date().toISOString())} ${clock(new Date().toISOString()).slice(0, 5)}.`,
    first && last ? `${sessions.size} opencode session(s), ${days.join(", ")}, from ${clock(first.at)} to ${clock(last.at)} (${minutes(first.at, last.at)} min).` : "No events recorded.",
    "",
    "## Plan, as it stands",
    "",
    plan,
    "",
    "## Numbers",
    "",
    `- Edits of the code checked in the browser: ${checks.length}, of which ${checksFailed} failed`,
    `- Plan saves: ${count("plan")}; writes blocked: ${count("blocked")}`,
    `- Phase tests: ${tests.length} run, ${testsPassed} fully passed; free test plays: ${count("play")}; lookups: ${count("lookup")}`,
    "",
    "## Timeline",
    "",
    ...entries.filter((e) => e.event !== "export").map((e) => `- ${clock(e.at)} ${headline(e)}`),
    "",
    "## Phase tests, blocked writes and failed checks, in full",
    "",
  ]
  for (const e of entries) {
    if (e.event === "test" || e.event === "blocked" || (e.event === "check" && e.detail.failing)) {
      lines.push(`### ${clock(e.at)} ${headline(e).split(" — ")[0]}`, "", "```", (e.text ?? "").trim(), "```", "")
    }
  }
  return lines.join("\n")
}

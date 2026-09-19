import type { Diagnostic } from "./compile/diagnostics.ts"
import type { CompileResult } from "./compile/dotnet.ts"

export type ReportOptions = {
  /** Project-relative paths touched by the tool call: their deprecation warnings are reported too. */
  editedFiles: string[]
  hints: (d: Diagnostic) => string[]
  maxErrors?: number
}

const OBSOLETE_WARNINGS = new Set(["CS0618", "CS0612"])
const MAX_LOCATIONS = 4

type Group = { first: Diagnostic; locations: string[] }

/** The same mistake repeated on several lines is reported, and explained, once. */
function group(diagnostics: Diagnostic[]): Group[] {
  const groups = new Map<string, Group>()
  for (const d of diagnostics) {
    const key = `${d.code}:${d.message}`
    const existing = groups.get(key)
    if (existing) existing.locations.push(`${d.file}:${d.line}`)
    else groups.set(key, { first: d, locations: [`${d.file}:${d.line}`] })
  }
  return [...groups.values()]
}

/** Drops the compiler's generic advice: the hint below the error is more specific. */
function shorten(message: string): string {
  return message
    .replace(/ and no accessible extension method .*$/, "")
    .replace(/ \(are you missing a using directive or an assembly reference\?\)/, "")
}

function renderGroup(index: number, g: Group, hints: string[], sameAs?: number): string {
  const shown = g.locations.slice(0, MAX_LOCATIONS).join(", ")
  const more = g.locations.length > MAX_LOCATIONS ? ` (+${g.locations.length - MAX_LOCATIONS} more)` : ""
  const lines = [`${index}) ${g.first.code}: ${shorten(g.first.message)}`, `   at ${shown}${more}`]
  if (sameAs !== undefined) {
    lines.push(`   FIX: same as ${sameAs})`)
  } else if (hints.length > 0) {
    lines.push(`   FIX: ${hints[0]}`)
    for (const hint of hints.slice(1)) lines.push(`   ${hint}`)
  }
  return lines.join("\n")
}

export function renderReport(result: CompileResult, options: ReportOptions): string {
  if (result.status === "unavailable") return `[unity] Compile check skipped: ${result.reason}`

  const edited = new Set(options.editedFiles)
  const errors = result.diagnostics.filter((d) => d.severity === "error")
  const deprecations = result.diagnostics.filter(
    (d) => d.severity === "warning" && OBSOLETE_WARNINGS.has(d.code) && edited.has(d.file),
  )
  const maxErrors = options.maxErrors ?? 8
  const sections: string[] = []

  if (errors.length > 0) {
    const groups = group(errors)
    sections.push(
      `[unity] Compile check FAILED: ${errors.length} error${errors.length === 1 ? "" : "s"}. Fix them before doing anything else.`,
    )
    // Two wrong arguments in one call produce two errors with the same fix: print it once.
    const printed = new Map<string, number>()
    groups.slice(0, maxErrors).forEach((g, i) => {
      const hints = options.hints(g.first)
      const key = hints.join("\n")
      sections.push(renderGroup(i + 1, g, hints, hints.length > 0 ? printed.get(key) : undefined))
      if (hints.length > 0 && !printed.has(key)) printed.set(key, i + 1)
    })
    if (groups.length > maxErrors) sections.push(`(+${groups.length - maxErrors} more distinct errors not shown)`)
  } else {
    sections.push("[unity] Compile check passed: 0 errors.")
  }

  if (deprecations.length > 0) {
    sections.push("[unity] Deprecated API in the file you edited. Replace it now:")
    group(deprecations).forEach((g, i) => sections.push(renderGroup(i + 1, g, options.hints(g.first))))
  }

  if (result.unchecked.length > 0) {
    sections.push(
      `[unity] Not checked (their assembly has no generated project yet, Unity must refresh first): ${result.unchecked.join(", ")}`,
    )
  }
  return sections.join("\n\n")
}

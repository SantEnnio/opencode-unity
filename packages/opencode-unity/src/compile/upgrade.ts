// Unity's own API renames, applied before Unity sees the code. Unity marks them on the obsolete
// API itself, `[Obsolete("... (UnityUpgradable) -> linearVelocity")]`, and when it compiles code
// that still uses one it stops on its API Updater dialog. The compiler reports each use as CS0618
// with that message, file, line and column: enough to make the same rename, at the same place.

import fs from "node:fs"
import path from "node:path"
import type { Diagnostic } from "./diagnostics.ts"

export type Upgrade = { file: string; line: number; column: number; from: string; to: string }
export type UpgradeResult = { file: string; line: number; from: string; to: string; before: string; after: string }

const IDENTIFIER = /^[A-Za-z_]\w*$/

/**
 * The renames Unity would make, from CS0618/CS0619 diagnostics. Only plain renames: a target with
 * an assembly, a namespace change or a different call shape stays a hint for the model.
 */
export function upgradesFrom(diagnostics: Diagnostic[]): Upgrade[] {
  const upgrades: Upgrade[] = []
  for (const d of diagnostics) {
    if (d.code !== "CS0618" && d.code !== "CS0619") continue
    const target = /\(UnityUpgradable\)\s*->\s*(.+?)'?\s*$/.exec(d.message)?.[1]?.trim()
    const subject = /^'([^']+)'/.exec(d.message)?.[1]
    if (!target || !subject) continue
    // 'Rigidbody.velocity', 'Object.FindObjectOfType<T>()', 'Rigidbody' -> the last name in it
    const from = subject.replace(/<[^>]*>/g, "").replace(/\(.*$/, "").split(".").at(-1)!
    if (!IDENTIFIER.test(from) || !IDENTIFIER.test(target) || from === target) continue
    upgrades.push({ file: d.file, line: d.line, column: d.column, from, to: target })
  }
  return upgrades
}

/**
 * Applies the renames in place. The compiler's column is where the expression starts (`rb` in
 * `rb.velocity`), so the old name is looked for from there on, as a whole word. Renames on the
 * same line go right to left so earlier columns stay valid.
 */
export function applyUpgrades(projectRoot: string, upgrades: Upgrade[]): UpgradeResult[] {
  const results: UpgradeResult[] = []
  const byFile = new Map<string, Upgrade[]>()
  for (const u of upgrades) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u])
  for (const [file, list] of byFile) {
    const full = path.resolve(projectRoot, file)
    let text: string
    try {
      text = fs.readFileSync(full, "utf8")
    } catch {
      continue
    }
    const newline = text.includes("\r\n") ? "\r\n" : "\n"
    const lines = text.split(/\r?\n/)
    const original = [...lines]
    const changed: UpgradeResult[] = []
    const seen = new Set<string>()
    for (const u of [...list].sort((a, b) => a.line - b.line || b.column - a.column)) {
      const key = `${u.line}:${u.column}:${u.from}`
      if (seen.has(key)) continue // one use reported twice (two target frameworks, two passes)
      seen.add(key)
      const before = lines[u.line - 1]
      if (before === undefined) continue
      const match = new RegExp(`\\b${u.from}\\b`).exec(before.slice(Math.max(0, u.column - 1)))
      if (!match) continue
      const at = Math.max(0, u.column - 1) + match.index
      const after = before.slice(0, at) + u.to + before.slice(at + u.from.length)
      lines[u.line - 1] = after
      changed.push({ file, line: u.line, from: u.from, to: u.to, before: "", after: "" })
    }
    if (changed.length === 0) continue
    fs.writeFileSync(full, lines.join(newline))
    // The whole line as it was and as it is now, however many renames it took.
    for (const c of changed) results.push({ ...c, before: original[c.line - 1]!.trim(), after: lines[c.line - 1]!.trim() })
  }
  return results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

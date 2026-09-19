import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { SCHEMA, SCHEMA_VERSION, stripGenerics } from "./db.ts"

type ExportedObsolete = { message: string; error: boolean }

type ExportedMember = {
  name: string
  kind: string
  sig: string
  static?: boolean
  type?: string
  extends?: string
  obsolete?: ExportedObsolete
  summary?: string
}

type ExportedType = {
  asm: string
  ns: string
  name: string
  simple: string
  full: string
  kind: string
  static?: boolean
  base?: string
  interfaces?: string[]
  obsolete?: ExportedObsolete
  summary?: string
  members: ExportedMember[]
}

export type GraphSource = {
  /** Directories scanned (non-recursively) for *.dll */
  dirs: string[]
  /** Assemblies to leave out, matched on the file name */
  exclude?: RegExp
  dbPath: string
  /** Changes whenever the inputs change: a matching cached database is reused as is. */
  fingerprint: string
}

// From source: <package>/bin. Installed: the bundle sits in <config>/plugins, its assets in <config>/opencode-unity.
const EXPORTER_CANDIDATES = [
  path.join(import.meta.dir, "..", "..", "bin", "symbol-exporter", "symbol-exporter.dll"),
  path.join(import.meta.dir, "..", "opencode-unity", "symbol-exporter", "symbol-exporter.dll"),
]

/**
 * Unity marks auto-upgradable APIs as "(UnityUpgradable) -> newName"; everything else says
 * "Use X instead" in prose. Both forms are reduced to the bare replacement name.
 */
export function parseReplacement(message: string): string | null {
  const upgradable = /\(UnityUpgradable\)\s*->\s*(.+)$/.exec(message)
  const raw = upgradable?.[1] ?? /\b[Uu]se\s+([A-Za-z_][\w.<>]*)/.exec(message)?.[1]
  if (!raw) return null
  const name = raw
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\(.*$/, "")
    .replace(/^\*\./, "")
    .replace(/[.,;:]+$/, "")
    .trim()
  return name.length > 0 && !/^(the|a|an|this|that|it)$/i.test(name) ? name : null
}

export function cleanObsoleteMessage(message: string): string {
  return message.replace(/\s*\(UnityUpgradable\)\s*->.*$/, "").trim()
}

export function ingest(db: Database, types: Iterable<ExportedType>, meta: Record<string, string>) {
  db.exec(SCHEMA)
  const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
  const insertType = db.prepare(
    `INSERT INTO types (asm, ns, name, simple, full, lookup, kind, is_static, base_lookup, obsolete, obsolete_error, replacement, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertMember = db.prepare(
    `INSERT INTO members (type_id, name, kind, sig, is_static, type, extends_lookup, obsolete, obsolete_error, replacement, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertEdge = db.prepare("INSERT INTO edges (src, rel, dst) VALUES (?, ?, ?)")

  db.transaction(() => {
    for (const [key, value] of Object.entries({ ...meta, schema: SCHEMA_VERSION })) insertMeta.run(key, value)

    for (const t of types) {
      const lookup = stripGenerics(t.full)
      const baseLookup = t.base ? stripGenerics(t.base) : null
      const typeReplacement = t.obsolete ? parseReplacement(t.obsolete.message) : null
      const { lastInsertRowid: typeId } = insertType.run(
        t.asm,
        t.ns,
        t.name,
        t.simple,
        t.full,
        lookup,
        t.kind,
        t.static ? 1 : 0,
        baseLookup,
        t.obsolete ? cleanObsoleteMessage(t.obsolete.message) : null,
        t.obsolete?.error ? 1 : 0,
        typeReplacement,
        t.summary ?? null,
      )

      if (baseLookup) insertEdge.run(lookup, "inherits", baseLookup)
      for (const iface of t.interfaces ?? []) insertEdge.run(lookup, "implements", stripGenerics(iface))
      if (typeReplacement) insertEdge.run(lookup, "replaced-by", typeReplacement)

      for (const m of t.members) {
        const replacement = m.obsolete ? parseReplacement(m.obsolete.message) : null
        insertMember.run(
          typeId,
          m.name,
          m.kind,
          m.sig,
          m.static ? 1 : 0,
          m.type ?? null,
          m.extends ? stripGenerics(m.extends) : null,
          m.obsolete ? cleanObsoleteMessage(m.obsolete.message) : null,
          m.obsolete?.error ? 1 : 0,
          replacement,
          m.summary ?? null,
        )
        if (replacement) insertEdge.run(`${lookup}.${m.name}`, "replaced-by", replacement)
      }
    }
  })()
}

export function* readJsonLines(file: string): Generator<ExportedType> {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.length > 0) yield JSON.parse(line) as ExportedType
  }
}

function isFresh(dbPath: string, fingerprint: string): boolean {
  if (!fs.existsSync(dbPath)) return false
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      const get = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      return get.get("fingerprint")?.value === fingerprint && get.get("schema")?.value === SCHEMA_VERSION
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

async function runExporter(dirs: string[], exclude: RegExp | undefined, outFile: string) {
  const exporter = EXPORTER_CANDIDATES.find((candidate) => fs.existsSync(candidate))
  if (!exporter) throw new Error(`symbol exporter not found (looked in ${EXPORTER_CANDIDATES.join(", ")})`)

  const args = ["--out", outFile]
  for (const dir of dirs) args.push("--dir", dir)
  if (exclude) args.push("--exclude", exclude.source)

  const proc = Bun.spawn(["dotnet", exporter, ...args], { stdout: "ignore", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (exitCode !== 0) throw new Error(`symbol exporter failed (${exitCode}): ${stderr.trim()}`)
}

/** Opens the cached database for a source, (re)building it first when the inputs changed. */
export async function ensureGraphDb(source: GraphSource): Promise<Database> {
  if (!isFresh(source.dbPath, source.fingerprint)) {
    fs.mkdirSync(path.dirname(source.dbPath), { recursive: true })
    const suffix = `${process.pid}-${Date.now()}`
    const jsonl = `${source.dbPath}.${suffix}.jsonl`
    const building = `${source.dbPath}.${suffix}.tmp`
    try {
      await runExporter(source.dirs, source.exclude, jsonl)
      const db = new Database(building, { create: true })
      try {
        ingest(db, readJsonLines(jsonl), { fingerprint: source.fingerprint })
      } finally {
        db.close()
      }
      try {
        fs.renameSync(building, source.dbPath)
      } catch (error) {
        // On Windows the target cannot be replaced while another opencode instance has it open.
        if (!fs.existsSync(source.dbPath)) throw error
      }
    } finally {
      fs.rmSync(jsonl, { force: true })
      fs.rmSync(building, { force: true })
    }
  }
  return new Database(source.dbPath, { readonly: true })
}

/** Newest mtime + count: cheap way to notice that Unity recompiled the project assemblies. */
export function dirFingerprint(dir: string, exclude?: RegExp): string {
  let newest = 0
  let count = 0
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".dll") || exclude?.test(file)) continue
    newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs)
    count++
  }
  return `${count}:${Math.round(newest)}`
}

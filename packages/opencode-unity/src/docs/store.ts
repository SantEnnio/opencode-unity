import { Database } from "../sqlite.ts"
import fs from "node:fs"

export const DOCS_SCHEMA_VERSION = "1"

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- manual | api | package
  path TEXT NOT NULL UNIQUE,   -- "Manual/class-Rigidbody", "ScriptReference/Rigidbody.AddForce", "com.unity.inputsystem/Actions"
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
-- External-content index: the text is stored once, in pages.
CREATE VIRTUAL TABLE pages_fts USING fts5 (title, body, content='pages', content_rowid='id', tokenize='porter unicode61');
`

export type DocKind = "manual" | "api" | "package"
export type DocHit = { kind: DocKind; path: string; title: string; snippet: string }
export type DocRow = { kind: DocKind; path: string; title: string; body: string }

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it my of on or that the this to unity use using what when where which with".split(" "),
)

/** Turns free text into an FTS5 query: quoted terms only, so user input can never be parsed as syntax. */
export function ftsQuery(text: string, operator: "AND" | "OR"): string | null {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter((t) => t.length > 1 && !STOPWORDS.has(t))
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(` ${operator} `)
}

export class DocsWriter {
  private readonly db: Database
  private readonly insert
  private readonly index

  constructor(file: string) {
    fs.rmSync(file, { force: true })
    this.db = new Database(file, { create: true })
    this.db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")
    this.db.exec(SCHEMA)
    this.insert = this.db.prepare("INSERT OR IGNORE INTO pages (kind, path, title, body) VALUES (?, ?, ?, ?)")
    this.index = this.db.prepare("INSERT INTO pages_fts (rowid, title, body) VALUES (?, ?, ?)")
    this.db.exec("BEGIN")
  }

  add(page: DocRow) {
    const { changes, lastInsertRowid } = this.insert.run(page.kind, page.path, page.title, page.body)
    if (changes > 0) this.index.run(lastInsertRowid, page.title, page.body)
  }

  finish(meta: Record<string, string>) {
    const insertMeta = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
    for (const [key, value] of Object.entries({ ...meta, schema: DOCS_SCHEMA_VERSION })) insertMeta.run(key, value)
    this.db.exec("COMMIT")
    this.db.exec("INSERT INTO pages_fts (pages_fts) VALUES ('optimize')")
    this.db.close()
  }

  abort() {
    this.db.close()
  }
}

export function docsMeta(file: string, key: string): string | null {
  if (!fs.existsSync(file)) return null
  try {
    const db = new Database(file, { readonly: true })
    try {
      const get = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      if (get.get("schema")?.value !== DOCS_SCHEMA_VERSION) return null
      return get.get(key)?.value ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Read-only view over the Unity docs database and the per-project package docs database. */
export class DocsStore {
  constructor(private readonly dbs: Database[]) {}

  static open(files: string[]): DocsStore {
    return new DocsStore(files.filter((f) => fs.existsSync(f)).map((f) => new Database(f, { readonly: true })))
  }

  get empty() {
    return this.dbs.length === 0
  }

  close() {
    for (const db of this.dbs) db.close()
  }

  search(text: string, limit = 6): DocHit[] {
    for (const operator of ["AND", "OR"] as const) {
      const query = ftsQuery(text, operator)
      if (!query) return []
      // bm25 scores are relative to each database, so they cannot be merged by value: a small
      // package corpus would never outrank the 34k-page manual. Interleave the rankings instead.
      const perDb = this.dbs.map((db) =>
        db
          .query<DocHit, [string, number]>(
            `SELECT p.kind, p.path, p.title, snippet(pages_fts, 1, '', '', ' … ', 24) AS snippet
             FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts, 10.0, 1.0) LIMIT ?`,
          )
          .all(query, limit),
      )
      const hits: DocHit[] = []
      for (let i = 0; hits.length < limit && perDb.some((list) => i < list.length); i++) {
        for (const list of perDb) if (list[i] && hits.length < limit) hits.push(list[i]!)
      }
      if (hits.length > 0) return hits.map(({ kind, path, title, snippet }) => ({ kind, path, title, snippet: snippet.replace(/\s+/g, " ").trim() }))
    }
    return []
  }

  /** Exact path, then path suffix ("Rigidbody.AddForce", "class-Rigidbody"), then exact title. */
  page(ref: string): DocRow | null {
    const clean = ref.trim().replace(/\.html?$/i, "").replace(/^\/+/, "")
    for (const db of this.dbs) {
      const row =
        db.query<DocRow, [string]>("SELECT kind, path, title, body FROM pages WHERE path = ? COLLATE NOCASE").get(clean) ??
        db.query<DocRow, [string]>("SELECT kind, path, title, body FROM pages WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT 1").get(`%/${clean.replace(/[\\%_]/g, "\\$&")}`) ??
        db.query<DocRow, [string]>("SELECT kind, path, title, body FROM pages WHERE title = ? COLLATE NOCASE ORDER BY length(path) LIMIT 1").get(clean)
      if (row) return row
    }
    return null
  }

  /** First C# example of a Scripting Reference page, trimmed for context. */
  example(apiPage: string, maxLines = 30): string | null {
    const body = this.page(`ScriptReference/${apiPage}`)?.body
    const code = body ? /```csharp\n([\s\S]*?)\n```/.exec(body)?.[1] : null
    if (!code) return null
    const lines = code.split("\n")
    return lines.length <= maxLines ? code : `${lines.slice(0, maxLines).join("\n")}\n// ... (${lines.length - maxLines} more lines: unity_docs_read("${apiPage}"))`
  }
}

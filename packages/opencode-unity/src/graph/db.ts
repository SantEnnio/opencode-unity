import { Database } from "bun:sqlite"

/** Bump when the exporter output or the tables change: cached databases are rebuilt. */
export const SCHEMA_VERSION = "1"

export const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE types (
  id INTEGER PRIMARY KEY,
  asm TEXT NOT NULL,
  ns TEXT NOT NULL,
  name TEXT NOT NULL,
  simple TEXT NOT NULL,
  full TEXT NOT NULL,
  lookup TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_static INTEGER NOT NULL DEFAULT 0,
  base_lookup TEXT,
  obsolete TEXT,
  obsolete_error INTEGER NOT NULL DEFAULT 0,
  replacement TEXT,
  summary TEXT
);
CREATE INDEX types_simple ON types (simple COLLATE NOCASE);
CREATE INDEX types_lookup ON types (lookup);

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES types (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sig TEXT NOT NULL,
  is_static INTEGER NOT NULL DEFAULT 0,
  type TEXT,
  extends_lookup TEXT,
  obsolete TEXT,
  obsolete_error INTEGER NOT NULL DEFAULT 0,
  replacement TEXT,
  summary TEXT
);
CREATE INDEX members_type ON members (type_id);
CREATE INDEX members_name ON members (name COLLATE NOCASE);
CREATE INDEX members_extends ON members (extends_lookup);

-- src/dst are lookup keys: "UnityEngine.Rigidbody" or "UnityEngine.Rigidbody.velocity"
CREATE TABLE edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL);
CREATE INDEX edges_src ON edges (src, rel);
CREATE INDEX edges_dst ON edges (dst, rel);
`

export type TypeRow = {
  id: number
  asm: string
  ns: string
  name: string
  simple: string
  full: string
  lookup: string
  kind: string
  is_static: number
  base_lookup: string | null
  obsolete: string | null
  obsolete_error: number
  replacement: string | null
  summary: string | null
}

export type MemberRow = {
  id: number
  type_id: number
  name: string
  kind: string
  sig: string
  is_static: number
  type: string | null
  extends_lookup: string | null
  obsolete: string | null
  obsolete_error: number
  replacement: string | null
  summary: string | null
}

export type GraphType = TypeRow & { layer: number }
export type GraphMember = MemberRow & { declaringType: string }

/** "UnityEngine.Events.UnityEvent<T0>" -> "UnityEngine.Events.UnityEvent" */
export function stripGenerics(name: string): string {
  let depth = 0
  let out = ""
  for (const c of name) {
    if (c === "<") depth++
    else if (c === ">") depth--
    else if (depth === 0) out += c
  }
  return out.replace(/\[,*\]|\?|\*/g, "").trim()
}

const MAX_BASE_DEPTH = 16

/**
 * Read-only view over one or more symbol databases. Layers are searched in order:
 * the Editor layer (engine + editor modules) first, then the project layer (packages).
 */
export class SymbolGraph {
  constructor(private readonly layers: Database[]) {}

  close() {
    for (const db of this.layers) db.close()
  }

  /** Exact qualified name first, then simple name (case-insensitive). */
  findTypes(name: string): GraphType[] {
    const key = stripGenerics(name)
    const exact = this.queryTypes("SELECT * FROM types WHERE lookup = ?", key)
    if (exact.length > 0) return exact
    const simple = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key
    return this.queryTypes("SELECT * FROM types WHERE simple = ? COLLATE NOCASE", simple)
  }

  /** The type followed by its base types, nearest first. */
  baseChain(type: GraphType): GraphType[] {
    const chain = [type]
    let current = type
    while (current.base_lookup && chain.length < MAX_BASE_DEPTH) {
      const next = this.queryTypes("SELECT * FROM types WHERE lookup = ?", current.base_lookup)[0]
      if (!next || chain.some((t) => t.lookup === next.lookup)) break
      chain.push(next)
      current = next
    }
    return chain
  }

  /** Declared and inherited members, plus extension methods that target the type or a base. */
  membersOf(type: GraphType): GraphMember[] {
    const chain = this.baseChain(type)
    const members: GraphMember[] = []
    for (const t of chain) {
      const db = this.layers[t.layer]!
      for (const row of db.query<MemberRow, [number]>("SELECT * FROM members WHERE type_id = ?").all(t.id)) {
        if (row.kind === "ctor" && t !== type) continue
        members.push({ ...row, declaringType: t.name })
      }
    }
    for (const t of chain) members.push(...this.queryMembers("m.extends_lookup = ?", t.lookup))
    return members
  }

  /** Every distinct simple type name, for fuzzy matching (a few thousand strings). */
  typeNames(): string[] {
    this.typeNameCache ??= [
      ...new Set(
        this.layers.flatMap((db) => db.query<{ simple: string }, []>("SELECT DISTINCT simple FROM types").all().map((r) => r.simple)),
      ),
    ]
    return this.typeNameCache
  }

  private typeNameCache: string[] | undefined

  membersNamed(name: string): GraphMember[] {
    return this.queryMembers("m.name = ? COLLATE NOCASE", name)
  }

  meta(key: string): string | null {
    for (const db of this.layers) {
      const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
      if (row) return row.value
    }
    return null
  }

  private queryTypes(sql: string, param: string): GraphType[] {
    return this.layers.flatMap((db, layer) =>
      db
        .query<TypeRow, [string]>(sql)
        .all(param)
        .map((row) => ({ ...row, layer })),
    )
  }

  private queryMembers(where: string, param: string): GraphMember[] {
    const sql = `SELECT m.*, t.name AS declaringType FROM members m JOIN types t ON t.id = m.type_id WHERE ${where}`
    return this.layers.flatMap((db) => db.query<GraphMember, [string]>(sql).all(param))
  }
}

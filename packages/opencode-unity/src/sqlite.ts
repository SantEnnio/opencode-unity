// One SQLite API over the two built-in drivers: bun:sqlite on Bun (opencode CLI) and node:sqlite
// on Node (opencode desktop). No native module to install, which is the whole point.

type RunResult = { changes: number; lastInsertRowid: number }

export interface Statement<Row, Params extends unknown[] = unknown[]> {
  all(...params: Params): Row[]
  get(...params: Params): Row | null
  run(...params: Params): RunResult
}

type DriverStatement = { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
type DriverDatabase = { prepare(sql: string): DriverStatement; exec(sql: string): void; close(): void }

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
// The specifiers are computed so bundlers leave both imports alone.
const driver: Record<string, new (file: string, options?: object) => DriverDatabase> = await import(isBun ? "bun:sqlite" : "node:sqlite")

export class Database {
  private readonly db: DriverDatabase
  private readonly statements = new Map<string, DriverStatement>()

  constructor(file: string, options: { readonly?: boolean; create?: boolean } = {}) {
    this.db = isBun
      ? new driver.Database!(file, options.readonly ? { readonly: true } : { readwrite: true, create: true })
      : new driver.DatabaseSync!(file, { readOnly: options.readonly === true })
  }

  /** Prepared once per SQL text and reused. */
  query<Row, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params> {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)))
    const prepared = statement
    return {
      all: (...params) => prepared.all(...params) as Row[],
      get: (...params) => (prepared.get(...params) as Row | undefined) ?? null,
      run: (...params) => {
        const result = prepared.run(...params)
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
      },
    }
  }

  prepare<Params extends unknown[] = unknown[]>(sql: string): Statement<unknown, Params> {
    return this.query<unknown, Params>(sql)
  }

  exec(sql: string) {
    this.db.exec(sql)
  }

  transaction(body: () => void): () => void {
    return () => {
      this.db.exec("BEGIN")
      try {
        body()
        this.db.exec("COMMIT")
      } catch (error) {
        this.db.exec("ROLLBACK")
        throw error
      }
    }
  }

  close() {
    this.statements.clear()
    this.db.close()
  }
}

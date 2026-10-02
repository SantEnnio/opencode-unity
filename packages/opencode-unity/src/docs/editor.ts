// The Unity documentation comes with the Editor: Unity Hub's "Documentation" module puts the Manual
// and the Scripting Reference next to the Editor it belongs to, matching that version exactly. The
// plugin indexes that folder once per Editor version and never downloads documentation itself.

import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "../unity/discovery.ts"
import { htmlToText } from "./html.ts"
import { docsMeta, DocsWriter } from "./store.ts"

export type Progress = (message: string) => void

// Where the Hub puts the module, relative to the versioned Editor install directory. The macOS one
// is measured (6000.0.71f1, 6000.3.24f1); the others follow the Editor's Windows and Linux layout.
const DOCS_LAYOUTS = [
  ["Documentation", "en"],
  ["Editor", "Data", "Documentation", "en"],
  ["Data", "Documentation", "en"],
  ["Unity.app", "Contents", "Documentation", "en"],
]

/** The installed documentation of an Editor, or null when its Documentation module is missing. */
export function editorDocsDir(editorRoot: string): string | null {
  for (const layout of DOCS_LAYOUTS) {
    const dir = path.join(editorRoot, ...layout)
    if (fs.existsSync(path.join(dir, "ScriptReference")) && fs.existsSync(path.join(dir, "Manual"))) return dir
  }
  return null
}

export const docsDbPath = (unityVersion: string) => path.join(cacheDir(), "docs", `${unityVersion}.db`)
export const packageDocsDbPath = (projectRoot: string) => path.join(projectRoot, "Library", "OpencodeUnity", "package-docs.db")

const SECTIONS = ["Manual", "ScriptReference"] as const
// Index pages and generated listings: no content a model could use.
const SKIPPED_PAGES = /^(index|30_search|docdata|StaticFiles|TableOfContents)/i

const htmlPages = (dir: string, section: string) => {
  try {
    return fs.readdirSync(path.join(dir, section)).filter((name) => name.toLowerCase().endsWith(".html"))
  } catch {
    return []
  }
}

/** Changes when the module is reinstalled or updated: a matching index is reused as is. */
function fingerprint(dir: string): string {
  return [dir, ...SECTIONS.map((section) => `${section}:${htmlPages(dir, section).length}:${Math.round(fs.statSync(path.join(dir, section)).mtimeMs)}`)].join("|")
}

export const docsReady = (unityVersion: string, dir: string) => docsMeta(docsDbPath(unityVersion), "fingerprint") === fingerprint(dir)

/** Builds the index. Yields every few hundred pages: 35,000 pages take long enough to stall the host otherwise. */
export async function indexEditorDocs(dir: string, dbFile: string, progress: Progress = () => {}): Promise<number> {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const building = `${dbFile}.${process.pid}.tmp`
  const writer = new DocsWriter(building)
  let count = 0
  try {
    const files = SECTIONS.flatMap((section) => htmlPages(dir, section).map((name) => ({ section, name: name.replace(/\.html$/i, "") })))
    for (const [i, { section, name }] of files.entries()) {
      if (i % 250 === 0) {
        await new Promise((resolve) => setImmediate(resolve))
        if (i > 0 && i % 5000 === 0) progress(`indexing ${Math.round((i / files.length) * 100)}%`)
      }
      if (SKIPPED_PAGES.test(name)) continue
      const { title, body } = htmlToText(fs.readFileSync(path.join(dir, section, `${name}.html`), "utf8"))
      if (body.length < 40) continue
      writer.add({ kind: section === "Manual" ? "manual" : "api", path: `${section}/${name}`, title: title || name, body })
      count++
    }
    writer.finish({ fingerprint: fingerprint(dir), source: dir, pages: String(count) })
    fs.renameSync(building, dbFile)
  } catch (error) {
    writer.abort()
    throw error
  } finally {
    fs.rmSync(building, { force: true })
  }
  return count
}

const indexing = new Map<string, Promise<number>>()

/** Indexes an Editor's documentation unless a current index exists. Concurrent calls share one run. */
export function ensureEditorDocs(unityVersion: string, dir: string, progress: Progress = () => {}): Promise<number> {
  // Up to 0.3.0 the plugin downloaded the docs itself, into one index per release stream: 60 MB each.
  const stream = /^(\d+\.\d+)\./.exec(unityVersion)?.[1]
  if (stream) fs.rmSync(path.join(path.dirname(docsDbPath(unityVersion)), `${stream}.db`), { force: true })
  const running = indexing.get(unityVersion)
  if (running) return running
  if (docsReady(unityVersion, dir)) return Promise.resolve(Number(docsMeta(docsDbPath(unityVersion), "pages") ?? 0))
  const run = indexEditorDocs(dir, docsDbPath(unityVersion), progress).finally(() => indexing.delete(unityVersion))
  indexing.set(unityVersion, run)
  return run
}

export const docsIndexing = (unityVersion: string) => indexing.has(unityVersion)

function* markdownFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* markdownFiles(full)
    else if (entry.name.toLowerCase().endsWith(".md")) yield full
  }
}

/**
 * Package documentation ships inside the packages themselves (Documentation~/*.md), so it is
 * already on disk and matches the installed versions exactly.
 */
export function indexPackageDocs(projectRoot: string): string | null {
  const roots = [path.join(projectRoot, "Library", "PackageCache"), path.join(projectRoot, "Packages")]
  const packages: { name: string; docs: string }[] = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const docs = path.join(root, entry.name, "Documentation~")
      if (fs.existsSync(docs)) packages.push({ name: entry.name.replace(/@.*$/, ""), docs })
    }
  }
  if (packages.length === 0) return null

  const dbFile = packageDocsDbPath(projectRoot)
  const packageFingerprint = packages.map((p) => path.basename(path.dirname(p.docs))).sort().join("|")
  if (docsMeta(dbFile, "fingerprint") === packageFingerprint) return dbFile

  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const building = `${dbFile}.${process.pid}.tmp`
  const writer = new DocsWriter(building)
  try {
    for (const pkg of packages) {
      for (const file of markdownFiles(pkg.docs)) {
        const body = fs.readFileSync(file, "utf8")
        if (body.length < 40) continue
        const relative = path.relative(pkg.docs, file).split(path.sep).join("/").replace(/\.md$/i, "")
        const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? relative
        writer.add({ kind: "package", path: `${pkg.name}/${relative}`, title: `${title} (${pkg.name})`, body })
      }
    }
    writer.finish({ fingerprint: packageFingerprint })
    fs.renameSync(building, dbFile)
  } catch (error) {
    writer.abort()
    throw error
  } finally {
    fs.rmSync(building, { force: true })
  }
  return dbFile
}

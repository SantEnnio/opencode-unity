import fs from "node:fs"
import path from "node:path"
import { cacheDir } from "../unity/discovery.ts"
import { htmlToText } from "./html.ts"
import { docsMeta, DocsWriter } from "./store.ts"
import { ZipReader } from "./zip.ts"

export type Progress = (message: string) => void

/** "6000.0.71f1" -> "6000.0": Unity publishes one documentation archive per release stream. */
export function docsStream(unityVersion: string): string {
  return /^(\d+\.\d+)/.exec(unityVersion)?.[1] ?? unityVersion
}

export const docsUrl = (stream: string) => `https://cloudmedia-docs.unity3d.com/docscloudstorage/en/${stream}/UnityDocumentation.zip`
export const docsDbPath = (unityVersion: string) => path.join(cacheDir(), "docs", `${docsStream(unityVersion)}.db`)
export const packageDocsDbPath = (projectRoot: string) => path.join(projectRoot, "Library", "OpencodeUnity", "package-docs.db")

export const docsInstalled = (unityVersion: string) => docsMeta(docsDbPath(unityVersion), "stream") === docsStream(unityVersion)

async function download(url: string, file: string, progress: Progress) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${url}`)
  const total = Number(response.headers.get("content-length") ?? 0)
  const out = fs.createWriteStream(file)
  let received = 0
  let nextReport = 0
  try {
    for await (const chunk of response.body) {
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()))
      received += chunk.length
      if (total > 0 && received >= nextReport) {
        progress(`downloading ${Math.round((received / total) * 100)}% of ${Math.round(total / 1e6)} MB`)
        nextReport += total / 10
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
}

const DOC_ENTRY = /(?:^|\/)(Manual|ScriptReference)\/([^/]+)\.html$/
// Index pages and generated listings: no content a model could use.
const SKIPPED_PAGES = /^(index|30_search|docdata|StaticFiles|TableOfContents)/i

export function indexZip(zipFile: string, dbFile: string, meta: Record<string, string>, progress: Progress = () => {}): number {
  const zip = ZipReader.open(zipFile)
  const building = `${dbFile}.${process.pid}.tmp`
  const writer = new DocsWriter(building)
  let count = 0
  try {
    const entries = zip.entries.filter((e) => DOC_ENTRY.test(e.name))
    for (const [i, entry] of entries.entries()) {
      const [, section, name] = DOC_ENTRY.exec(entry.name)!
      if (SKIPPED_PAGES.test(name!)) continue
      const { title, body } = htmlToText(zip.read(entry).toString("utf8"))
      if (body.length < 40) continue
      writer.add({ kind: section === "Manual" ? "manual" : "api", path: `${section}/${name}`, title: title || name!, body })
      count++
      if (i % 5000 === 0 && i > 0) progress(`indexing ${Math.round((i / entries.length) * 100)}%`)
    }
    writer.finish({ ...meta, pages: String(count) })
    fs.renameSync(building, dbFile)
  } catch (error) {
    writer.abort()
    throw error
  } finally {
    zip.close()
    fs.rmSync(building, { force: true })
  }
  return count
}

const installs = new Map<string, Promise<number>>()

/** Downloads and indexes the documentation of a Unity release stream. Concurrent calls share one run. */
export function installDocs(unityVersion: string, progress: Progress = () => {}, keepZip = false): Promise<number> {
  const stream = docsStream(unityVersion)
  const running = installs.get(stream)
  if (running) return running

  const run = (async () => {
    const dbFile = docsDbPath(unityVersion)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    const zipFile = path.join(path.dirname(dbFile), `${stream}.zip`)
    try {
      if (!fs.existsSync(zipFile)) {
        const partial = `${zipFile}.part`
        await download(docsUrl(stream), partial, progress)
        fs.renameSync(partial, zipFile)
      }
      progress("indexing")
      const pages = indexZip(zipFile, dbFile, { stream, source: docsUrl(stream) }, progress)
      progress(`done: ${pages} pages`)
      return pages
    } finally {
      if (!keepZip) fs.rmSync(zipFile, { force: true })
      fs.rmSync(`${zipFile}.part`, { force: true })
      installs.delete(stream)
    }
  })()
  installs.set(stream, run)
  return run
}

export const docsInstalling = (unityVersion: string) => installs.has(docsStream(unityVersion))

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
  const fingerprint = packages.map((p) => path.basename(path.dirname(p.docs))).sort().join("|")
  if (docsMeta(dbFile, "fingerprint") === fingerprint) return dbFile

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
    writer.finish({ fingerprint })
    fs.renameSync(building, dbFile)
  } catch (error) {
    writer.abort()
    throw error
  } finally {
    fs.rmSync(building, { force: true })
  }
  return dbFile
}

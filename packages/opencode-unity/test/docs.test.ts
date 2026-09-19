import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { htmlToText } from "../src/docs/html.ts"
import { docsStream, indexZip } from "../src/docs/install.ts"
import { DocsStore, ftsQuery } from "../src/docs/store.ts"
import { ZipReader } from "../src/docs/zip.ts"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-test-"))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Builds a zip by hand so the test needs no zip tool: even entries stored, odd ones deflated. */
function makeZip(file: string, files: Record<string, string>) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  Object.entries(files).forEach(([name, content], i) => {
    const raw = Buffer.from(content)
    const method = i % 2 === 0 ? 0 : 8
    const data = method === 0 ? raw : zlib.deflateRawSync(raw)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  })
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]))
}

const page = (title: string, article: string) =>
  `<html><head><title>Unity - Scripting API: ${title}</title></head><body><div id="sidebar">NAV JUNK</div>
   <div id="content-wrap"><div class="section"><h1>${title}</h1>
   <div class="suggest"><div class="inner"><p>Thank you for helping</p></div></div>${article}</div>
   <div id="_content"></div><div class="footer-wrapper">FOOTER JUNK</div></div></body></html>`

describe("zip", () => {
  test("reads stored and deflated entries", () => {
    const file = path.join(tmp, "a.zip")
    makeZip(file, { "a/one.txt": "hello", "a/two.txt": "world ".repeat(200) })
    const zip = ZipReader.open(file)
    expect(zip.entries.map((e) => e.name)).toEqual(["a/one.txt", "a/two.txt"])
    expect(zip.read(zip.entries[0]!).toString()).toBe("hello")
    expect(zip.read(zip.entries[1]!).toString()).toBe("world ".repeat(200))
    zip.close()
  })

  test("rejects files that are not zips", () => {
    const file = path.join(tmp, "not.zip")
    fs.writeFileSync(file, "x".repeat(100))
    expect(() => ZipReader.open(file)).toThrow("not a zip file")
  })
})

describe("htmlToText", () => {
  test("keeps the article, drops page furniture, preserves code", () => {
    const { title, body } = htmlToText(
      page("Rigidbody.AddForce", `<h2>Description</h2><p>Adds a &lt;force&gt; to the <a href="x">Rigidbody</a>.</p><pre class="codeExampleCS">void F()\n{\n    rb.AddForce(Vector3.up);\n}</pre><ul><li>one</li><li>two</li></ul>`),
    )
    expect(title).toBe("Rigidbody.AddForce")
    expect(body).toContain("# Rigidbody.AddForce")
    expect(body).toContain("## Description")
    expect(body).toContain("Adds a <force> to the Rigidbody.")
    expect(body).toContain("```csharp\nvoid F()\n{\n    rb.AddForce(Vector3.up);\n}\n```")
    expect(body).toContain("- one\n- two")
    expect(body).not.toMatch(/JUNK|Thank you/)
  })
})

describe("docs index", () => {
  const zipFile = path.join(tmp, "docs.zip")
  const dbFile = path.join(tmp, "docs.db")
  makeZip(zipFile, {
    "Documentation/en/ScriptReference/Rigidbody.AddForce.html": page("Rigidbody.AddForce", "<p>Adds a force to the rigidbody so it accelerates.</p><pre>rb.AddForce(Vector3.up);</pre>"),
    "Documentation/en/Manual/class-Rigidbody.html": page("Rigidbody component reference", "<p>Use the Rigidbody component to move a GameObject with physics forces.</p>"),
    "Documentation/en/Manual/index.html": page("Index", "<p>Landing page that must not be indexed at all, whatever it says about forces.</p>"),
    "Documentation/en/StaticFiles/logo.png": "binary",
  })

  test("indexes Manual and ScriptReference pages only", () => {
    expect(indexZip(zipFile, dbFile, { stream: "6000.0" })).toBe(2)
  })

  test("search, page lookup and examples", () => {
    const docs = DocsStore.open([dbFile, path.join(tmp, "missing.db")])
    expect(docs.search("how to add a force")[0]?.path).toBe("ScriptReference/Rigidbody.AddForce")
    expect(docs.search("component physics").map((h) => h.kind)).toEqual(["manual"])
    expect(docs.search("zzzz")).toEqual([])
    expect(docs.search('") OR (')).toEqual([])
    expect(docs.page("Rigidbody.AddForce")?.kind).toBe("api")
    expect(docs.page("Manual/class-Rigidbody.html")?.title).toBe("Rigidbody component reference")
    expect(docs.page("nope")).toBeNull()
    expect(docs.example("Rigidbody.AddForce")).toBe("rb.AddForce(Vector3.up);")
    docs.close()
  })

  test("query building ignores stop words and FTS syntax", () => {
    expect(ftsQuery("How do I move the Rigidbody?", "AND")).toBe('"move" AND "rigidbody"')
    expect(ftsQuery("the of to", "OR")).toBeNull()
    expect(docsStream("6000.0.71f1")).toBe("6000.0")
    expect(docsStream("2022.3.10f1")).toBe("2022.3")
  })
})

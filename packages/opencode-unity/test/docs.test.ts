import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { htmlToText } from "../src/docs/html.ts"
import { editorDocsDir, indexEditorDocs } from "../src/docs/editor.ts"
import { DocsStore, ftsQuery } from "../src/docs/store.ts"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-test-"))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const page = (title: string, article: string) =>
  `<html><head><title>Unity - Scripting API: ${title}</title></head><body><div id="sidebar">NAV JUNK</div>
   <div id="content-wrap"><div class="section"><h1>${title}</h1>
   <div class="suggest"><div class="inner"><p>Thank you for helping</p></div></div>${article}</div>
   <div id="_content"></div><div class="footer-wrapper">FOOTER JUNK</div></div></body></html>`

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
  // An Editor install with Unity Hub's Documentation module, laid out as on macOS.
  const editorRoot = path.join(tmp, "Editor", "6000.0.71f1")
  const docsDir = path.join(editorRoot, "Documentation", "en")
  const dbFile = path.join(tmp, "docs.db")
  const write = (relative: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(docsDir, relative)), { recursive: true })
    fs.writeFileSync(path.join(docsDir, relative), content)
  }
  write("ScriptReference/Rigidbody.AddForce.html", page("Rigidbody.AddForce", "<p>Adds a force to the rigidbody so it accelerates.</p><pre>rb.AddForce(Vector3.up);</pre>"))
  write("Manual/class-Rigidbody.html", page("Rigidbody component reference", "<p>Use the Rigidbody component to move a GameObject with physics forces.</p>"))
  write("Manual/index.html", page("Index", "<p>Landing page that must not be indexed at all, whatever it says about forces.</p>"))
  write("StaticFiles/logo.png", "binary")

  test("finds the Editor's Documentation module", () => {
    expect(editorDocsDir(editorRoot)).toBe(docsDir)
    expect(editorDocsDir(path.join(tmp, "Editor", "no-docs"))).toBeNull()
    // Windows keeps the Editor's files under Editor\Data.
    const windowsRoot = path.join(tmp, "Win", "6000.0.71f1")
    fs.mkdirSync(path.join(windowsRoot, "Editor", "Data", "Documentation", "en", "Manual"), { recursive: true })
    fs.mkdirSync(path.join(windowsRoot, "Editor", "Data", "Documentation", "en", "ScriptReference"), { recursive: true })
    expect(editorDocsDir(windowsRoot)).toBe(path.join(windowsRoot, "Editor", "Data", "Documentation", "en"))
  })

  test("indexes Manual and ScriptReference pages only", async () => {
    expect(await indexEditorDocs(docsDir, dbFile)).toBe(2)
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
  })
})

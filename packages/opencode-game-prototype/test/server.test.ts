import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createPrototype } from "../src/project.ts"
import { createServer, withProbe } from "../src/server.ts"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-test-")))
const prototype = createPrototype(root, "jump")
fs.writeFileSync(path.join(root, "secret.txt"), "not for the browser")
const server = createServer({ folder: (name) => (name === "jump" ? prototype.dir : null), names: () => ["jump"], probe: "/* probe */", preferredPort: 0 })
const port = await server.start()
const at = (address: string) => `http://127.0.0.1:${port}${address}`
afterAll(() => server.close())

/** A request with the path exactly as given: fetch would tidy `..` away before sending. */
const raw = (address: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: address, headers }, (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on("error", reject)
  })

describe("probe tag", () => {
  test("goes before the first script, so before the import map", () => {
    const html = withProbe('<head><title>x</title><script type="importmap">{}</script></head>')
    expect(html.indexOf("/__proto/probe.js")).toBeLessThan(html.indexOf("importmap"))
    expect(html.indexOf("/__proto/probe.js")).toBeGreaterThan(html.indexOf("</title>"))
  })

  test("a page with no script still gets it", () => {
    expect(withProbe("<head></head><body>hi</body>")).toBe('<head><script src="/__proto/probe.js"></script></head><body>hi</body>')
    expect(withProbe("hi")).toBe('<script src="/__proto/probe.js"></script>hi')
  })
})

describe("server", () => {
  test("serves the prototype, with the probe in its page and nothing cached", async () => {
    const page = await fetch(at("/jump/"))
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(await page.text()).toContain('<script src="/__proto/probe.js"></script>\n<script type="importmap">')
    const script = await fetch(at("/jump/main.js"))
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await script.text()).toContain('from "kit"')
    expect(await (await fetch(at("/__proto/probe.js"))).text()).toBe("/* probe */")
    expect((await fetch(at("/jump"), { redirect: "manual" })).headers.get("location")).toBe("/jump/")
  })

  test("serves nothing outside a prototype", async () => {
    // Some of these are tidied to /secret.txt before routing (404), the encoded slash is caught as an escape (403).
    for (const address of ["/secret.txt", "/jump/../secret.txt", "/jump/%2e%2e/secret.txt", "/jump/..%2fsecret.txt", "/jump/..%5csecret.txt", "/other/index.html"]) {
      const answer = await raw(address)
      expect([403, 404]).toContain(answer.status)
      expect(answer.body).not.toContain("not for the browser")
    }
    expect((await raw("/jump/..%2fsecret.txt")).status).toBe(403)
  })

  test("answers only to this machine's own address", async () => {
    expect((await raw("/jump/", { host: "evil.example" })).status).toBe(403)
    expect((await raw("/jump/", { host: `localhost:${port}` })).status).toBe(200)
  })

  test("remembers the files a page asked for and did not get", async () => {
    const since = Date.now()
    expect((await fetch(at("/jump/enemy.js"))).status).toBe(404)
    await fetch(at("/favicon.ico"))
    expect(server.missingSince("jump", since)).toEqual(["enemy.js"])
    expect(server.missingSince("jump", Date.now() + 1000)).toEqual([])
  })

  test("a test play: the page fetches its script and posts its report", async () => {
    const spec = { steps: [{ keys: [{ code: "KeyD", key: "d", keyCode: 68 }], hold: 1, wait: 0 }], tail: 1 }
    const reported = server.expect("run1", spec)
    expect(await (await fetch(at("/__proto/run/run1"))).json()).toEqual(spec)
    expect((await fetch(at("/__proto/run/unknown"))).status).toBe(404)
    await fetch(at("/__proto/report/run1"), { method: "POST", body: JSON.stringify({ id: "run1", frames: 60 }) })
    expect((await reported).frames).toBe(60)
    server.forget("run1")
    expect((await fetch(at("/__proto/run/run1"))).status).toBe(404)
  })

  test("the user's tab is told to reload", async () => {
    const stream = await fetch(at("/__proto/live?page=jump"))
    const reader = stream.body!.getReader()
    const read = async () => new TextDecoder().decode((await reader.read()).value)
    expect(await read()).toBe(": connected\n\n")
    expect(server.tabs("jump")).toBe(1)
    server.tell("jump", "reload")
    expect(await read()).toBe("event: reload\ndata: \n\n")
    await reader.cancel()
  })
})

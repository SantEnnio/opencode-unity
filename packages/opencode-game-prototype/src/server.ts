// The local server a prototype runs from. A page with ES modules does not load from file://, and
// this is also where the probe gets into the page and where its reports come back. Plain
// node:http, on this machine only: nothing to install, no administrator rights, no open port on
// the network.

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import type { PageRun, TabReport } from "./report.ts"
import type { WebStep } from "./keys.ts"

export type RunSpec = { steps: WebStep[]; tail: number }

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
}

const PROBE_TAG = '<script src="/__proto/probe.js"></script>'

/** The probe goes before the page's first script, so it sees everything that script does. */
export function withProbe(html: string): string {
  const script = /<script\b/i.exec(html)
  if (script) return html.slice(0, script.index) + PROBE_TAG + "\n" + html.slice(script.index)
  const head = /<head[^>]*>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + PROBE_TAG + html.slice(head.index + head[0].length) : PROBE_TAG + html
}

const PREFERRED_PORT = 4317
const MAX_BODY = 1_000_000

export type PrototypeServer = ReturnType<typeof createServer>

/**
 * `folder` maps the first segment of an address to a prototype's folder, or null: only prototypes
 * are served, never the rest of the directory opencode was started in.
 */
export function createServer(options: { folder(name: string): string | null; names(): string[]; probe: string; preferredPort?: number }) {
  const runs = new Map<string, { spec: RunSpec; resolve(run: PageRun): void }>()
  const tabs = new Map<string, Set<http.ServerResponse>>()
  const tabReports = new Map<string, TabReport & { at: number }>()
  const missing: { page: string; file: string; at: number }[] = []
  let listening: Promise<number> | null = null

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
    res.end(body)
  }

  const body = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY) return void req.destroy()
        chunks.push(chunk)
      })
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", reject)
    })

  async function probeRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const [, , action, id] = url.pathname.split("/")
    if (action === "probe.js") return send(res, 200, options.probe, TYPES[".js"])

    if (action === "run" && id) {
      const run = runs.get(id)
      return run ? send(res, 200, JSON.stringify(run.spec), TYPES[".json"]) : send(res, 404, "no such run")
    }

    if (action === "report" && id && req.method === "POST") {
      const run = runs.get(id)
      const text = await body(req)
      send(res, 200, "ok")
      if (!run) return
      try {
        run.resolve(JSON.parse(text) as PageRun)
      } catch {
        // a report that cannot be read is no report: the run times out and says so
      }
      return
    }

    const page = url.searchParams.get("page") ?? ""
    if (action === "live") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
      res.write(": connected\n\n")
      let open = tabs.get(page)
      if (!open) tabs.set(page, (open = new Set()))
      open.add(res)
      req.on("close", () => open.delete(res))
      return
    }

    if (action === "events" && req.method === "POST") {
      const text = await body(req)
      send(res, 200, "ok")
      try {
        tabReports.set(page, { ...(JSON.parse(text) as TabReport), at: Date.now() })
      } catch {
        // ignore what cannot be read
      }
      return
    }

    send(res, 404, "not found")
  }

  function fileRoute(res: http.ServerResponse, url: URL) {
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return send(res, 400, "bad address")
    }
    if (pathname === "/") {
      const links = options.names().map((name) => `<li><a href="/${encodeURIComponent(name)}/">${name.replace(/[<>&"]/g, "")}</a></li>`).join("")
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Prototypes</title><body style="font:16px system-ui;margin:2em"><h1>Prototypes</h1><ul>${links || "<li>none yet</li>"}</ul>`, TYPES[".html"])
    }
    if (pathname === "/favicon.ico") return send(res, 204, "")

    const [, name = "", ...rest] = pathname.split("/")
    const folder = options.folder(name)
    if (!folder) return send(res, 404, "no such prototype")
    if (rest.length === 0) {
      res.writeHead(302, { location: `/${name}/${url.search}` })
      return void res.end()
    }
    const inside = rest.join("/") || "index.html"
    const file = path.resolve(folder, inside)
    if (file !== folder && !file.startsWith(folder + path.sep)) return send(res, 403, "outside the prototype")

    let content: Buffer
    try {
      content = fs.readFileSync(file)
    } catch {
      missing.push({ page: name, file: inside, at: Date.now() })
      if (missing.length > 200) missing.shift()
      return send(res, 404, `no file ${inside} in ${name}`)
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
    if (type.startsWith("text/html")) return send(res, 200, withProbe(content.toString("utf8")), type)
    send(res, 200, content, type)
  }

  const server = http.createServer((req, res) => {
    // Only this machine's own browser, by address: a page elsewhere cannot reach in under another name.
    const host = req.headers.host ?? ""
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, "local only")
    const url = new URL(req.url ?? "/", `http://${host}`)
    if (url.pathname.startsWith("/__proto/")) {
      return void probeRoute(req, res, url).catch(() => {
        if (!res.headersSent) send(res, 500, "error")
      })
    }
    fileRoute(res, url)
  })
  // The server must never keep opencode from exiting.
  server.unref()

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once("error", failed)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", failed)
        resolve((server.address() as { port: number }).port)
      })
    })

  return {
    /** Starts on first use. The same port every time when it is free, so a bookmark keeps working. */
    start(): Promise<number> {
      listening ??= listen(options.preferredPort ?? PREFERRED_PORT).catch(() => listen(0))
      return listening
    },

    /** Registers a test play; the promise resolves with what the page reports. */
    expect(id: string, spec: RunSpec): Promise<PageRun> {
      return new Promise((resolve) => runs.set(id, { spec, resolve }))
    },
    forget(id: string) {
      runs.delete(id)
    },

    /** Files the page asked for since `since` that are not in the prototype. */
    missingSince(page: string, since: number): string[] {
      return [...new Set(missing.filter((m) => m.page === page && m.at >= since).map((m) => m.file))]
    },

    /** How many of the user's browser tabs have this prototype open. */
    tabs: (page: string) => tabs.get(page)?.size ?? 0,
    /** Tells the user's tabs to reload, or to run a test play. */
    tell(page: string, event: "reload" | "run", data = "") {
      for (const res of tabs.get(page) ?? []) res.write(`event: ${event}\ndata: ${data}\n\n`)
    },
    /** What the user's tab last said about the page, if it said anything. */
    tabReport: (page: string) => tabReports.get(page) ?? null,

    async close() {
      for (const open of tabs.values()) for (const res of open) res.end()
      tabs.clear()
      if (!listening) return
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

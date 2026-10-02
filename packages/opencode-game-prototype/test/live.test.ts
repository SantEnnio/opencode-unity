// The whole path with a real browser: the server, the probe in the page, three.js drawing, keys
// pressed, the report. Skipped where no Edge or Chrome is installed, or with PROTO_SKIP_LIVE=1.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findBrowser } from "../src/browser.ts"
import { createPrototypes } from "../src/core.ts"

const browser = findBrowser()

describe.skipIf(!browser || process.env.PROTO_SKIP_LIVE === "1")("in a real browser", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-live-")))
  const proto = createPrototypes(dir, { port: 0 }, () => {})!
  const context = { directory: dir, sessionID: "s", abort: new AbortController().signal, consent: async () => null }
  const main = path.join(dir, "coin-run", "main.js")
  const edit = (change: (source: string) => string) => {
    fs.writeFileSync(main, change(fs.readFileSync(main, "utf8")))
    return proto.afterWrite("edit", { filePath: main }, "s", dir)
  }

  test("the template runs: D walks the player into the coin and the score goes up", async () => {
    await proto.tools.proto_new!.execute({ name: "coin-run" }, context)
    const report = await proto.tools.proto_play!.execute({ keys: "D 1s" }, context)
    expect(report).toContain('keys "D 1s". No errors.')
    expect(report).toMatch(/- Player moved [45]\.\d: \(0\.0, 0\.5, 0\.0\) → \([45]\.\d, 0\.5, 0\.0\)/)
    expect(report).toContain("- Coin was removed at")
    expect(report).toContain('- Text on screen: "Score 0" → "Score 1"')
    expect(proto.idle("s")).toBeNull()
  }, 60_000)

  test("an edit that breaks the page is caught, explained, and holds the model back", async () => {
    const report = await edit((source) => source.replace("new THREE.SphereGeometry(0.4)", "new THREE.CubeGeometry(1, 1, 1)"))
    expect(report).toContain('[proto] Page check FAILED: "coin-run" has 1 error.')
    expect(report).toContain("main.js:18: TypeError: THREE.CubeGeometry is not a constructor\n  FIX: three.js has no CubeGeometry: use THREE.BoxGeometry.")
    expect(proto.idle("s")?.text).toContain("You stopped, but the prototype has errors.")
  }, 60_000)

  test("the edit that fixes it passes", async () => {
    expect(await edit((source) => source.replace("new THREE.CubeGeometry(1, 1, 1)", "new THREE.BoxGeometry(1, 1, 1)"))).toMatch(/^\[proto\] Page check passed: "coin-run" loaded and drew \d+ frames with no errors\.$/)
    expect(proto.idle("s")).toBeNull()
    await proto.dispose()
  }, 60_000)
})

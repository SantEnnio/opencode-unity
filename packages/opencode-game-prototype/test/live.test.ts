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
    const report = await edit((source) => source.replace('game.sphere("Coin", 0.4, "gold")', "new THREE.Mesh(new THREE.CubeGeometry(1, 1, 1))"))
    expect(report).toContain('[proto] Page check FAILED: "coin-run" has 1 error.')
    expect(report).toMatch(/main\.js:\d+: TypeError: THREE\.CubeGeometry is not a constructor\n  FIX: three\.js has no CubeGeometry: use THREE\.BoxGeometry\./)
    expect(proto.idle("s")?.text).toContain("You stopped, but the prototype has errors.")
  }, 60_000)

  test("the edit that fixes it passes", async () => {
    expect(await edit((source) => source.replace("new THREE.Mesh(new THREE.CubeGeometry(1, 1, 1))", 'game.sphere("Coin", 0.4, "gold")'))).toMatch(/^\[proto\] Page check passed: "coin-run" loaded and drew \d+ frames with no errors\.$/)
    expect(proto.idle("s")).toBeNull()
  }, 60_000)

  test("proto_test runs the plan's phases, says what failed and what was seen, and writes the result into PLAN.md", async () => {
    const plan = path.join(dir, "coin-run", "PLAN.md")
    const text = fs
      .readFileSync(plan, "utf8")
      .replace("Write here, in two sentences: what the player does, and what this prototype must prove.", "Collect the coin.")
      .replace("### Phase 2: (title)", "### Phase 2: the coin")
      .replace('- Test: keys "..."\n- Expect: ...', '- Test: keys "D 1s"\n- Expect: Coin is removed\n- Expect: text contains "Score 1"\n- Expect: Player y > 3')
      // Seen with qwen: the player sank 0.3 a second while standing, because Box3 read the matrices of the previous frame.
      .replace("- Expect: Player jumps\n", "- Expect: Player jumps\n- Expect: Player ends at y = 0.5\n")
    fs.writeFileSync(plan, text)
    const report = await proto.tools.proto_test!.execute({}, context)
    expect(report).toContain('[proto] Tests of "coin-run": 1 of 2 phases pass.')
    expect(report).toContain("Phase 1 (the player moves and jumps): PASSED")
    expect(report).toContain("Phase 2 (the coin): FAILED\n- Coin is removed: yes\n- text contains \"Score 1\": yes\n- Player y > 3: NO. Player ended at y 0.5\nSeen:\n  - Player moved")
    expect(report.split("\n").at(-1)).toBe('→ Next: make phase 2 pass: change the code, then call proto_test with phase "2".')
    const statuses = fs.readFileSync(plan, "utf8").split("\n").filter((line) => line.startsWith("- Status:"))
    expect(statuses).toEqual(["- Status: passed", "- Status: failed"])
    expect(proto.idle("s")?.text).toContain("a phase of the prototype still fails its test")

    // The journal and SESSION.md travel with the folder.
    const session = fs.readFileSync(path.join(dir, "coin-run", "SESSION.md"), "utf8")
    expect(session).toContain("# coin-run: session report")
    expect(session).toContain("- Phase tests: 1 run, 0 fully passed")
    expect(session).toMatch(/- \d\d:\d\d:\d\d edit main.js: check FAILED — main.js:\d+: TypeError: THREE.CubeGeometry is not a constructor/)
    expect(session).toMatch(/- \d\d:\d\d:\d\d test all phases: 1\/2 passed — Player y > 3: NO. Player ended at y 0.5/)
    expect(fs.readFileSync(path.join(dir, "coin-run", ".proto", "journal.jsonl"), "utf8").split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(5)
    const exported = await proto.tools.proto_export!.execute({}, context)
    expect(exported).toContain("[proto] Report written: coin-run/SESSION.md")
    expect(proto.guardWrite("edit", { filePath: path.join(dir, "coin-run", "SESSION.md") }, dir)).toContain("the plugin's own record")

    const one = await proto.tools.proto_test!.execute({ phase: "1" }, context)
    expect(one).toContain('[proto] Tests of "coin-run": 1 of 1 phase pass.\nPhase 1 (the player moves and jumps): PASSED\n→ Next: go on to the next phase of PLAN.md.')
    expect(await proto.tools.proto_test!.execute({ phase: "7" }, context)).toContain("[proto] No phase '7' in PLAN.md. The phases are: 1 (the player moves and jumps), 2 (the coin).")
    await proto.dispose()
  }, 120_000)
})

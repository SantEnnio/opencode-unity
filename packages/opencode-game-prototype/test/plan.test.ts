import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { checkExpectation, markStatus, parsePlan, planProblems, planReady } from "../src/plan.ts"
import type { Outcome } from "../src/report.ts"

const template = fs.readFileSync(path.join(import.meta.dir, "..", "assets", "template", "PLAN.md"), "utf8")
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as Outcome
const written = template
  .replace("Write here, in two sentences: what the player does, and what this prototype must prove.", "The player collects the coin by walking into it.")
  .replace("### Phase 2: (title)", "### Phase 2: the coin")
  .replace('- Test: keys "..."\n- Expect: ...', '- Test: keys "D 1s"\n- Expect: Coin is removed\n- Expect: text contains "Score 1"')

describe("PLAN.md", () => {
  test("the template is not a plan yet, and says why", () => {
    expect(planReady(template)).toBe(false)
    expect(planProblems(template)).toEqual([
      "the Idea section is still the placeholder: write what the player does and what the prototype must prove",
      'Phase 2 has no Test line (for example: - Test: keys "D 1s; Space")',
      "Phase 2 has no Expect line",
    ])
    const { phases } = parsePlan(template)
    expect(phases.map((p) => [p.number, p.title, p.test, p.expects.length, p.status])).toEqual([
      [1, "the player moves and jumps", "D 1s; Space", 2, "todo"],
      [2, "(title)", null, 0, "todo"],
    ])
  })

  test("a written plan is ready; the forms list in it is not read as phases", () => {
    expect(planReady(written)).toBe(true)
    expect(planProblems(written)).toEqual([])
    expect(parsePlan(written).phases.length).toBe(2)
  })

  test("headings and lines as a model varies them", () => {
    const loose = ["## Idea", "Jump twice.", "", "## Phase 1 - double jump", "* test: Space; wait 0.3s; Space", "* expect: Player jumps 2 times", "* Expect: Player rises at least 1.5", "", "#### Phase 2: third press", "- Test: keys 'Space; Space; Space'", "- Expect: Player jumps 2 times."].join("\n")
    const { phases, ideaWritten } = parsePlan(loose)
    expect(ideaWritten).toBe(true)
    expect(phases.map((p) => [p.title, p.test, p.expects])).toEqual([
      ["double jump", "Space; wait 0.3s; Space", ["Player jumps 2 times", "Player rises at least 1.5"]],
      ["third press", "Space; Space; Space", ["Player jumps 2 times."]],
    ])
    expect(planProblems(loose)).toEqual([])
  })

  // qwen3.6-35b-a3b, asked for a moving platform, wrote the plan this way: no Idea heading, bold
  // keys with backticks, the expectations as bullets under a bare "Expect:", in Italian.
  test("a plan as qwen wrote it: prose instead of an Idea section, bold keys, bullets under Expect", () => {
    const text = [
      "# Moving Platform",
      "",
      "Una pedana si muove avanti e indietro sopra un buco. Il giocatore che ci salta sopra viene trasportato.",
      "",
      "### Phase 1 — Terreno con buco + pedana mobile",
      "",
      "Sostituisci il terreno unico con due segmenti separati.",
      "",
      "**Test:** `D 2s`",
      "**Expect:**",
      '- La pedana (nome "Platform") si muove avanti e indietro',
      "- Platform moves",
      "",
      "### Phase 2 — Trasporto",
      "**Test:** keys `W 0.5s; Space 1s; D 3s`",
      "**Expect:** Player moves right",
    ].join("\n")
    const { phases, ideaWritten } = parsePlan(text)
    expect(ideaWritten).toBe(true)
    expect(phases.map((p) => [p.title, p.test, p.expects])).toEqual([
      ["Terreno con buco + pedana mobile", "D 2s", ['La pedana (nome "Platform") si muove avanti e indietro', "Platform moves"]],
      ["Trasporto", "W 0.5s; Space 1s; D 3s", ["Player moves right"]],
    ])
    expect(planReady(text)).toBe(true)
    expect(planProblems(text)).toEqual(['Phase 1: Expect "La pedana (nome "Platform") si muove avanti e indietro" is not a form the plugin can check', expect.stringContaining("Expect lines are English, one per line, in exactly these forms")])
  })

  test("a Test line that cannot be read, and an Expect line that is not a form, are named", () => {
    const bad = written.replace('- Test: keys "D 1s"', '- Test: keys "walk right"').replace('- Expect: text contains "Score 1"', "- Expect: the coin sparkles")
    expect(planProblems(bad)).toEqual([expect.stringContaining("Phase 2: its Test line cannot be read. Unknown key 'walk right'"), 'Phase 2: Expect "the coin sparkles" is not a form the plugin can check', expect.stringContaining("Expect lines are English")])
    const onlySample = written.replace(/### Phase 2[\s\S]*?- Status: todo\n/, "")
    expect(planReady(onlySample)).toBe(false)
    expect(planProblems(onlySample)).toEqual(["the only phase is the sample one: add the phases of this prototype"])
  })

  // qwen, on the platform task, ended with "Player moved" three times in phase 2 and the same two
  // lines in phase 3: all green, nothing proven.
  test("repeated Expect lines, and a phase that expects nothing new, are called out", () => {
    const weak = written
      .replace('- Expect: Coin is removed\n- Expect: text contains "Score 1"', "- Expect: Player moves\n- Expect: Player moves")
      .replace("## Numbers that worked", '### Phase 3: fall\n- Test: keys "A 3s"\n- Expect: Player moves\n- Status: todo\n\n## Numbers that worked')
    expect(planProblems(weak)).toEqual([
      "Phase 2 repeats the same Expect line: each line must check something different",
      "Phase 3 expects exactly what phase 2 expects: add what this phase changes (a position, a removed object, the text on screen, a jump count)",
    ])
  })

  test("the status is written next to the phase, replacing or adding the line", () => {
    const marked = markStatus(markStatus(written, 1, "passed"), 2, "failed")
    expect(marked.split("\n").filter((line) => line.startsWith("- Status:"))).toEqual(["- Status: passed", "- Status: failed"])
    const noStatus = written.replace("- Status: todo\n\n### Phase 2", "\n### Phase 2")
    const added = markStatus(noStatus, 1, "passed")
    expect(added.indexOf("- Status: passed")).toBeGreaterThan(added.indexOf("- Expect: Player jumps"))
    expect(added.indexOf("- Status: passed")).toBeLessThan(added.indexOf("### Phase 2"))
  })
})

describe("Expect lines against a recorded play", () => {
  const coin = fixture("play-coin")
  const jump = fixture("play-jump")
  const check = (expect: string, outcome = coin) => {
    const v = checkExpectation(expect, outcome)
    return `${v.ok === null ? "?" : v.ok ? "yes" : "NO"}: ${v.seen}`
  }

  test("movement, direction, stillness", () => {
    expect(check("Player moves")).toBe("yes: Player moved 5.1")
    expect(check("Player moves right")).toBe("yes: Player went from (0.0, 0.5, 0.0) to (5.1, 0.5, 0.0) (x grew)")
    expect(check("Player moves left")).toBe("NO: Player went from (0.0, 0.5, 0.0) to (5.1, 0.5, 0.0)")
    expect(check("Ground does not move")).toBe("yes: Ground did not move")
    expect(check("the Player stays still")).toBe("NO: Player moved 5.1")
  })

  test("jumps and height", () => {
    expect(check("Player jumps", jump)).toBe("yes: Player was pushed upward 1 time(s), rose 1.2")
    expect(check("Player jumps 2 times", jump)).toBe("NO: Player was pushed upward 1 time(s), rose 1.2")
    expect(check("Player rises at least 1", jump)).toBe("yes: Player rose 1.2")
    expect(check("Player jumps")).toBe("NO: Player was pushed upward 0 time(s), rose 0.0")
  })

  test("removed, appeared, text, position, screen", () => {
    expect(check("Coin is removed")).toBe("yes: Coin was removed at 0.6 s")
    expect(check("Coin disappears", jump)).toBe("NO: Coin was still there at the end")
    expect(check("Bullet appears")).toBe("NO: nothing named Bullet appeared")
    expect(check('text contains "Score 1"')).toBe('yes: text was "Score 1"')
    expect(parsePlan('### Phase 1: t\n- Test: keys "D 1s"\n- Expect: text contains "Score 1"\n- Expect: `Coin is removed`').phases[0]!.expects).toEqual(['text contains "Score 1"', "Coin is removed"])
    expect(check("text is GAME OVER")).toBe('NO: text was "Score 1"')
    expect(check('text does not contain "GAME OVER"')).toBe('yes: text was "Score 1"')
    expect(check("Player x > 4")).toBe("yes: Player ended at x 5.1")
    expect(check("Player ends at y < 0")).toBe("NO: Player ended at y 0.5")
    expect(check("Player z = 0")).toBe("yes: Player ended at z 0.0")
    expect(check("Player is on screen")).toBe("yes: Player ended on screen")
    expect(check("no errors")).toBe("yes: no errors")
  })

  test("the forms added for the platform session: back and forth, falls, reset, ends at, above", () => {
    const trace = (points: [number, number, number, number][]) => points
    const platform = { label: "Platform", start: [0, 0.2, 0] as [number, number, number], end: [1.2, 0.2, 0] as [number, number, number], far: 3.4, rose: 0, added: null, removed: null, onScreen: true, trace: trace([[0, 0, 0.2, 0], [1, 4, 0.2, 0], [2, 1.2, 0.2, 0]]) }
    const faller = { label: "Player", start: [0, 0.5, 0] as [number, number, number], end: [0, 0.5, 0] as [number, number, number], far: 6, rose: 0, added: null, removed: null, onScreen: true, trace: trace([[0, 0, 0.5, 0], [1, 2, -6, 0], [1.1, 0, 0.5, 0]]) }
    const rider = { ...faller, label: "Rider", end: [1.0, 0.7, 0] as [number, number, number], trace: trace([[0, 0, 0.5, 0], [1, 1, 0.7, 0]]) }
    const outcome: Outcome = { ...coin, run: { ...coin.run, objects: [platform, faller, rider] } }
    expect(check("Platform moves back and forth", outcome)).toBe("yes: Platform went both ways, 3.4 from where it started at most")
    expect(check("Platform moves left", outcome)).toBe("yes: Platform went from (0.0, 0.2, 0.0) to (1.2, 0.2, 0.0) (x shrank)")
    expect(check("Player falls into the hole", outcome)).toBe("yes: Player started at y 0.5 and got down to y -6.0")
    expect(check("Player is reset", outcome)).toBe("yes: Player jumped to another position at 1.1 s, ending at (0.0, 0.5, 0.0)")
    expect(check("Player ends at (0, 0.5, 0)", outcome)).toBe("yes: Player ended at (0.0, 0.5, 0.0)")
    expect(check("Rider is on Platform", outcome)).toBe("yes: Rider ended at (1.0, 0.7, 0.0), Platform at (1.2, 0.2, 0.0)")
    expect(check("Rider is reset", outcome)).toBe("NO: Rider never jumped position; it ended at (1.0, 0.7, 0.0)")
    expect(check("Platform is above Rider", outcome)).toBe("NO: Platform ended at (1.2, 0.2, 0.0), Rider at (1.0, 0.7, 0.0)")
  })

  // qwen, on the falling enemies: "the game stops" at GAME OVER had no form, so it settled for
  // "Player x > 5". These say what it meant.
  test("what happens after the text on screen changes", () => {
    const player = { label: "Player", start: [0, 0.5, 0] as [number, number, number], end: [9.5, 0.5, 0] as [number, number, number], far: 9.5, rose: 0, added: null, removed: null, onScreen: true, trace: [[0, 0, 0.5, 0], [1, 5, 0.5, 0], [1.9, 9.5, 0.5, 0], [3, 9.5, 0.5, 0], [6, 9.5, 0.5, 0]] as [number, number, number, number][] }
    const early = { label: "Enemy", start: [5, 9, 0] as [number, number, number], end: [5, -1, 0] as [number, number, number], far: 10, rose: 0, added: 0.6, removed: 1.5, onScreen: true, trace: [[0.6, 5, 9, 0], [1.5, 5, -1, 0]] as [number, number, number, number][] }
    const late = { ...early, added: 3.2, removed: null, trace: [[3.2, 8, 9, 0], [4, 8, 2, 0]] as [number, number, number, number][] }
    const stopped: Outcome = { ...coin, run: { ...coin.run, hud: ["", "GAME OVER"], hudChanged: 1.9, objects: [player, early] } }
    const running: Outcome = { ...coin, run: { ...coin.run, hud: ["", "GAME OVER"], hudChanged: 1.9, objects: [{ ...player, end: [14, 0.5, 0], trace: [...player.trace, [6.1, 14, 0.5, 0]] }, early, late] } }
    expect(check("Player does not move after the text changes", stopped)).toBe("yes: Player did not move after the text changed at 1.9 s")
    expect(check("no Enemy appears after the text changes", stopped)).toBe("yes: nothing named Enemy appeared after the text changed at 1.9 s")
    expect(check("nothing moves after the text changes", stopped)).toBe("yes: nothing moved or appeared after the text changed at 1.9 s")
    expect(check("Player stops moving after the text says GAME OVER", running)).toBe("NO: Player moved 4.5 after the text changed at 1.9 s")
    expect(check("no more Enemy appear after the text changes", running)).toBe("NO: 1 named Enemy appeared after the text changed at 1.9 s, the last at 3.2 s")
    expect(check("the game stops after the text changes", running)).toBe("NO: after the text changed at 1.9 s: Player moved 4.5, Enemy moved 7.0; 1 object(s) appeared")
    expect(check("nothing moves after the text changes", coin)).toBe('NO: the text on screen never changed (it was "Score 1")')
    expect(check("Player does not move", stopped)).toBe("NO: Player moved 9.5")
  })

  test("names that do not exist, and lines that are not forms", () => {
    expect(check("Enemy moves")).toBe("NO: no object named Enemy was in the scene (seen: Ground, Player, Coin, Camera)")
    expect(check("Player flies away")).toBe("?: not one of the forms at the end of PLAN.md")
  })

  test("a name covers its numbered copies, and colour words", () => {
    const outcome: Outcome = { ...coin, run: { ...coin.run, objects: [...coin.run.objects, { label: "Enemy2", start: [0, 0, 0], end: [0, 0, 0], far: 0, rose: 0, added: null, removed: 1.2, onScreen: true, color: ["ffdd00", "ff0000"], colorChanged: 1 }] } }
    expect(check("Enemy is removed", outcome)).toBe("yes: Enemy2 was removed at 1.2 s")
    expect(check("Enemy turns red", outcome)).toBe("yes: Enemy2 ended red (#ff0000)")
    expect(check("Enemy changes colour", outcome)).toBe("yes: Enemy2 went from #ffdd00 to #ff0000")
    expect(check("Coin turns red", outcome)).toBe("NO: Coin has no colour")
  })
})

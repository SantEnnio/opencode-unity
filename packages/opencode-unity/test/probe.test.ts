import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pluginPackage from "../package.json" with { type: "json" }
import { installedProbe, installProbe, PROBE_VERSION, probeState, rememberObjects, uninstallProbe } from "../src/probe/package.ts"
import { notable, objectTimeline, playNote, type ProbeRun, type ProbeSample, readRun, runReport } from "../src/probe/report.ts"

// Recorded by the probe in Unity 6000.0.71f1: a cube with a Rigidbody falls 4.5 m onto a plane.
const fall = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "probe-fall.json"), "utf8")) as ProbeRun

const run = (overrides: Partial<ProbeRun>): ProbeRun => ({ ...fall, logs: [], contacts: [], keys: [], actions: [], objects: [], ...overrides })
const still = (x: number, y: number, z: number, until = 5): ProbeSample[] =>
  Array.from({ length: until * 10 + 1 }, (_, i) => [i / 10, x, y, z, 0, 0, 0, 1] as ProbeSample)

describe("probe report", () => {
  test("a real recording: the fall, the landing, the collision", () => {
    expect(playNote(fall)).toBe("[unity] Recorded by the runtime probe while the user played. Last play 3.6 s, 3139 frames: no errors, nothing unusual. Details: unity_play.")
    const report = runReport(fall)
    expect(report).toContain("/Faller: (0.0, 5.0, 0.0) → (0.0, 0.5, 0.0)")
    expect(report).toContain("Collisions: /Faller ↔ /Floor at 1.0 s")
    expect(objectTimeline(fall, "Faller")).toBe(
      [
        "[unity] /Faller (Rigidbody) in the last play, 3.6 s:",
        "- 0.0–1.0 s moved (0.0, 5.0, 0.0) → (0.0, 0.5, 0.0), 4.5 m, top speed 9.2 m/s",
        "- 1.0–3.6 s still at (0.0, 0.5, 0.0)",
        "- hit /Floor once, first at 1.0 s",
      ].join("\n"),
    )
  })

  test("a real recording: an exception, and the Error Pause that stopped the game", () => {
    const paused = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "probe-error-pause.json"), "utf8")) as ProbeRun
    const note = playNote(paused)
    expect(note).toContain("NullReferenceException in Thrower.Update () (Assets/Scripts/Thrower.cs:9), 1×, first at 1.0 s: Object reference not set")
    expect(note).toContain("The game was paused at 1.0 s for 1.2 s: Unity pauses on the first error when Error Pause is on in the Console")
    expect(note.split("\n").length).toBeLessThanOrEqual(5)
  })

  test("a pause alone still points somewhere real", () => {
    const note = playNote(run({ pausedTime: 3, pausedAt: 2 }))
    expect(note).toContain("The game was paused at 2.0 s for 3.0 s")
    expect(note).toContain("→ unity_play shows the whole run.")
    expect(note).not.toContain("undefined")
  })

  test("a test play started by unity_play says so", () => {
    expect(runReport(run({ startedBy: "agent" })).split("\n")[0]).toBe("[unity] Test play 3.6 s with no input, 3139 frames. No errors, nothing unusual.")
  })

  // Recorded: an error in Start pauses the game in its first frame, before EnteredPlayMode reaches
  // the probe. It once read as "the game did not run, bring Unity to the front".
  test("a real recording: an error in the first frame, and the pause it caused", () => {
    const start = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "probe-start-error.json"), "utf8")) as ProbeRun
    const report = runReport(start)
    expect(report).not.toContain("did not run")
    expect(report).toContain("MissingComponentException in BallLauncher.Start () (Assets/Scripts/BallTest.cs:20)")
    expect(report).toContain("The game was paused at 0.0 s for 5.0 s")
  })

  test("a game that did not advance gets no diagnosis", () => {
    const frozen = run({ frames: 3, gameTime: 0.02, realTime: 6 })
    expect(notable(frozen)).toBe(true)
    expect(playNote(frozen)).toContain("the game did not run")
    expect(runReport(frozen)).toContain("bring its window to the front")
  })

  test("exceptions come first, collapsed, with where and how often", () => {
    const broken = run({
      logs: [{ kind: "NullReferenceException", message: "Object reference not set to an instance of an object", where: "PlayerController.Update () (at Assets/Scripts/PlayerController.cs:12)", count: 360, first: 0.1 }],
    })
    const note = playNote(broken)
    expect(note.split("\n")[0]).toBe("[unity] Recorded by the runtime probe while the user played. Last play 3.6 s, 3139 frames: 1 problem.")
    expect(note).toContain("NullReferenceException in PlayerController.Update () (Assets/Scripts/PlayerController.cs:12), 360×, first at 0.1 s")
    expect(note).toContain("unity_console")
  })

  test("the absence that matters: keys held, the player never moved", () => {
    const stuck = run({
      objects: [{ path: "/Player", body: "Rigidbody", dynamic: true, spawned: null, destroyed: null, samples: still(0, 1, 0) }],
      keys: [{ key: "W", count: 1, first: 0.5, held: 4 }],
      actions: [],
    })
    const note = playNote(stuck)
    expect(note).toContain("Keys were held for 4.0 s and nothing moved (/Player)")
    expect(note).toContain('unity_play path "/Player"')
    expect(runReport(stuck)).toContain("Input: W held 4.0 s. No Input System action fired")
  })

  test("falling through the floor and NaN positions", () => {
    const falling: ProbeSample[] = [[0, 0, 1, 0, 0, 0, 0, 1], [1, 0, -5, 0, 0, -10, 0, 1], [2, null, null, null, null, null, null, 1]]
    const note = playNote(run({ lowestStatic: 0, objects: [{ path: "/Ball", body: "Rigidbody", dynamic: true, spawned: null, destroyed: null, samples: falling }] }))
    expect(note).toContain("/Ball fell below the lowest floor (y 0.0) at 1.0 s")
    expect(note).toContain("/Ball: position became invalid (NaN) at 2.0 s")
  })

  test("every note stays within five lines, however much went wrong", () => {
    const chaos = run({
      logs: Array.from({ length: 20 }, (_, i) => ({ kind: "Exception", message: `boom ${i}`, where: `A.M${i} ()`, count: i + 1, first: i })),
      objects: Array.from({ length: 12 }, (_, i) => ({ path: `/O${i}`, body: "Rigidbody", dynamic: true, spawned: null, destroyed: null, samples: still(i, 0, 0) })),
      keys: [{ key: "W", count: 1, first: 0, held: 3 }],
    })
    expect(playNote(chaos).split("\n").length).toBeLessThanOrEqual(5)
    expect(runReport(chaos).split("\n").length).toBeLessThanOrEqual(14)
  })

  test("a long timeline is merged to a few segments", () => {
    // Moves for 0.5 s, stops for 0.5 s, fifty times over.
    const samples: ProbeSample[] = Array.from({ length: 500 }, (_, i) => {
      const x = Math.floor(i / 10) % 2 === 0 ? i * 0.1 : Math.floor(i / 10) * 1
      return [i / 10, x, 0, 0, 1, 0, 0, 1]
    })
    const timeline = objectTimeline(run({ objects: [{ path: "/Car", body: "Rigidbody", dynamic: true, spawned: null, destroyed: null, samples }] }), "/Car")
    expect(timeline.split("\n").length).toBeLessThanOrEqual(10)
  })

  test("an object that was not recorded says what was", () => {
    expect(objectTimeline(fall, "/Nope")).toContain("Recorded: /Faller")
  })
})

describe("probe package", () => {
  test("ships with the plugin's version", () => {
    expect(PROBE_VERSION).toBe(pluginPackage.version)
  })

  test("install, update, uninstall, and the objects to watch", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-probe-"))
    try {
      fs.mkdirSync(path.join(project, "Packages"))
      expect(probeState(project)).toBe("missing")
      installProbe(project)
      expect(installedProbe(project)).toBe(PROBE_VERSION)
      expect(probeState(project)).toBe("current")
      expect(fs.existsSync(path.join(project, "Packages", "com.opencode-unity.probe", "Editor", "Probe.cs"))).toBe(true)

      const manifest = path.join(project, "Packages", "com.opencode-unity.probe", "package.json")
      fs.writeFileSync(manifest, JSON.stringify({ version: "0.0.1" }))
      expect(probeState(project)).toBe("outdated")

      rememberObjects(project, ["/Car", "/Car/Body"])
      rememberObjects(project, ["/Player", "/Car"])
      const watch = JSON.parse(fs.readFileSync(path.join(project, "Library", "OpencodeUnity", "probe", "watch.json"), "utf8"))
      expect(watch.paths).toEqual(["/Player", "/Car", "/Car/Body"])

      expect(readRun(project)).toBeNull()
      expect(uninstallProbe(project)).toBe(true)
      expect(probeState(project)).toBe("missing")
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("play note in a session", () => {
  const project = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-unity-note-"))
    fs.mkdirSync(path.join(root, "ProjectSettings"), { recursive: true })
    fs.writeFileSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.71f1\n")
    fs.mkdirSync(path.join(root, "Packages"))
    installProbe(root)
    return root
  }
  const record = (root: string, overrides: Partial<ProbeRun>) => {
    fs.mkdirSync(path.join(root, "Library", "OpencodeUnity", "probe"), { recursive: true })
    fs.writeFileSync(path.join(root, "Library", "OpencodeUnity", "probe", "last-run.json"), JSON.stringify({ ...fall, endedAt: new Date().toISOString(), ...overrides }))
  }

  test("goes with the user's next two messages, then is dropped", async () => {
    const { createUnity } = await import("../src/core.ts")
    const root = project()
    try {
      const unity = createUnity(root, { docs: "manual" }, () => {})!
      unity.userMessage("s", {}, "m0")
      expect(unity.playNote("s")).toBeNull()
      record(root, { id: "run1" })
      unity.userMessage("s", {}, "m1")
      expect(unity.playNote("s")).toEqual({ text: expect.stringContaining("Recorded by the runtime probe while the user played"), messageID: "m1" })
      unity.userMessage("s", {}, "m2")
      expect(unity.playNote("s")?.messageID).toBe("m1")
      unity.userMessage("s", {}, "m3")
      expect(unity.playNote("s")).toBeNull()
      // A play started by unity_play was already the tool's answer.
      record(root, { id: "run2", startedBy: "agent" })
      unity.userMessage("s", {}, "m4")
      expect(unity.playNote("s")).toBeNull()
      // An old play is not news.
      record(root, { id: "run3", endedAt: new Date(Date.now() - 2 * 3600_000).toISOString() })
      unity.userMessage("s", {}, "m5")
      expect(unity.playNote("s")).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("key scripts", () => {
  // Recorded by qwen3.6-35b-a3b's own test play after fixing a jump bound to J instead of Space.
  test("a real recording: a jump in place, and a second player that the key does not drive", () => {
    const jump = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "probe-jump.json"), "utf8")) as ProbeRun
    const report = runReport(jump)
    expect(report).toContain("No errors, nothing unusual.")
    expect(report).not.toContain("never moved")
    expect(report).toContain("/ActionPlayer: went up to y 1.7 and came back to (-2.0, 0.5, 0.0)")
    expect(objectTimeline(jump, "/ActionPlayer")).toContain("went up to y 1.7 and came back to (-2.0, 0.5, 0.0)")
  })


  test("the forms a model writes", async () => {
    const { parseKeys } = await import("../src/probe/keys.ts")
    expect(parseKeys("W 2s; Space; W+D 1s; wait 1s")).toEqual({
      steps: [
        { keys: ["W"], hold: 2, wait: 0 },
        { keys: ["Space"], hold: 0.1, wait: 0 },
        { keys: ["W", "D"], hold: 1, wait: 0 },
        { keys: [], hold: 0, wait: 1 },
      ],
      total: expect.closeTo(4.4, 5),
      text: "W 2s; Space; W+D 1s; wait 1s",
    })
    expect(parseKeys("shift+w for 2 seconds")).toMatchObject({ text: "LeftShift+W 2s" })
    expect(parseKeys("up 500ms, left, 3")).toMatchObject({ text: "UpArrow 0.5s; LeftArrow; Digit3" })
    expect(parseKeys("jump")).toContain("Unknown key 'jump'")
    expect(parseKeys("W 25s")).toContain("at most 20 s")
    expect(parseKeys("")).toContain("No keys given")
  })

  test("a real recording: W held, Space tapped, both kinds of scripts moved", () => {
    const keys = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "probe-keys.json"), "utf8")) as ProbeRun
    const report = runReport(keys)
    expect(report.split("\n")[0]).toBe('[unity] Test play 4.9 s with keys "W 2s; Space", 3651 frames. No errors, nothing unusual.')
    expect(report).toContain("Input: W held 2.0 s, Space ×1. Actions: Move ×1, Jump ×1")
    expect(objectTimeline(keys, "/ActionPlayer")).toContain("highest y 1.7")
    expect(objectTimeline(keys, "/KeyboardPlayer")).toContain("moved (2.0, 0.5, 0.0) → (2.0, 0.5, 5.8)")
  })
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fixFor, instead, threeExports, unknownNames } from "../src/api.ts"
import { checkReport, type Outcome, playReport } from "../src/report.ts"

// Recorded from headless Chrome running the template (three.js r186), unchanged or broken in one line.
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as Outcome
const exports = threeExports(path.join(import.meta.dir, "..", "node_modules", "three", "build"))

describe("test play report", () => {
  test("a real recording: D held for a second walks into the coin", () => {
    const { failing, report } = playReport("coin-run", fixture("play-coin"))
    expect(failing).toBe(false)
    expect(report.split("\n")).toEqual([
      '[proto] Test play of "coin-run": 2.1 s, 127 frames, keys "D 1s". No errors.',
      "- Player moved 5.1: (0.0, 0.5, 0.0) → (5.1, 0.5, 0.0)",
      "- Coin was removed at 0.6 s",
      '- Text on screen: "Score 0" → "Score 1"',
      "- Did not move: Ground",
      "→ Next: if this is what the step should do, go on to the next step. If not, change the code and call proto_play again.",
    ])
  })

  test("a real recording: a jump comes back to where it started, and its height is said", () => {
    expect(playReport("coin-run", fixture("play-jump")).report).toContain("- Player moved 1.2 away from (0.0, 0.5, 0.0) and came back, rose 1.2, pushed upward once (at 0.0 s)")
  })

  // Seen with qwen3.6-35b-a3b: it pressed Space three times to test a double jump and reported
  // "the third does nothing" from a height alone. The count is what shows it.
  test("jumps are counted, so a double jump can be told from a single or a triple one", () => {
    const outcome = fixture("play-jump")
    const objects = outcome.run.objects.map((o) => (o.label === "Player" ? { ...o, rose: 1.6, far: 1.6, pushedUp: [0, 0.5] } : o))
    expect(playReport("coin-run", { ...outcome, keys: "Space; wait 0.3s; Space; wait 0.1s; Space", run: { ...outcome.run, objects } }).report).toContain("rose 1.6, pushed upward 2 times (at 0.0 s, 0.5 s)")
  })

  test("a real recording: an error inside the loop, and the freeze it causes", () => {
    const { failing, report } = playReport("coin-run", fixture("play-error-in-loop"))
    expect(failing).toBe(true)
    expect(report).toContain("FAILED, 1 error:\n- main.js:46: TypeError: coin.explode is not a function")
    expect(report).toContain("- The game stopped at 0.6 s: the error is inside the game loop, which ends there.")
    expect(report.split("\n").at(-1)).toBe("→ Next: fix main.js line 46. Then call proto_play again.")
  })

  // From a qwen3.6-35b-a3b session (falling enemies): seven lines of "Enemy appeared", and a
  // player that went right and came back reported as "moved 10.1: (0.0, …) → (0.1, …)".
  test("many objects under one name are one line, and out-and-back is told from ending far away", () => {
    const outcome = fixture("check-ok")
    const enemy = (added: number, x: number, far: number, removed: number | null) => ({ label: "Enemy", start: [x, 5.9, 0] as [number, number, number], end: [x, 5.9 - far, 0] as [number, number, number], far, rose: 0, added, removed, onScreen: true })
    const objects = [
      ...outcome.run.objects.map((o) => (o.label === "Player" ? { ...o, far: 10.1, end: [0.1, 0.5, 0] as [number, number, number] } : o)),
      enemy(0.5, 1.7, 7.9, 2.5),
      enemy(1.3, -1.6, 7.9, 3.3),
      enemy(2.1, 4.5, 4.4, null),
    ]
    const lines = playReport("dodge", { ...outcome, keys: "D 2s; A 2s", held: 4, run: { ...outcome.run, objects } }).report.split("\n")
    expect(lines).toContain("- Player moved 10.1 away from (0.0, 0.5, 0.0) and ended at (0.1, 0.5, 0.0)")
    expect(lines).toContain("- 3 objects named Enemy appeared, the first at 0.5 s at (1.7, 5.9, 0.0), the last at 2.1 s; they moved up to 7.9; 2 were removed")
    expect(lines.filter((line) => line.includes("Enemy")).length).toBe(1)
  })

  // Same session: the model wrote "the game freezes" on GAME OVER while enemies kept spawning.
  // With the time of the text change next to the time of the last enemy, the report shows it.
  test("the text on screen says when it changed", () => {
    const outcome = fixture("check-ok")
    const report = playReport("dodge", { ...outcome, run: { ...outcome.run, hud: ["", "GAME OVER"], hudChanged: 2.41 } }).report
    expect(report).toContain('- Text on screen: "" → "GAME OVER" (at 2.4 s)')
  })

  test("keys held and nothing moved is said first", () => {
    const outcome = fixture("check-ok")
    const report = playReport("coin-run", { ...outcome, keys: "J 1s", held: 1 }).report
    expect(report.split("\n")[1]).toBe("- Keys were held for 1.0 s and nothing moved.")
  })

  test("a background tab is not a broken game", () => {
    const outcome = fixture("check-ok")
    const { failing, report } = playReport("coin-run", { ...outcome, ranIn: "tab", run: { ...outcome.run, frames: 0, visible: false } })
    expect(failing).toBe(false)
    expect(report).toBe('[proto] Game NOT tested: The browser tab was in the background, so the page did not run. Ask the user to bring the tab with "coin-run" to the front, then call proto_play again.')
  })
})

describe("page check report", () => {
  test("a real recording: the unchanged template passes in one line", () => {
    expect(checkReport("coin-run", fixture("check-ok"))).toEqual({ failing: false, report: '[proto] Page check passed: "coin-run" loaded and drew 62 frames with no errors.' })
  })

  test("a real recording: a class three.js removed, with the one to use", () => {
    const { failing, report } = checkReport("coin-run", { ...fixture("check-old-api"), fixFor: (text) => fixFor(text, exports) })
    expect(failing).toBe(true)
    expect(report.split("\n")).toEqual([
      '[proto] Page check FAILED: "coin-run" has 1 error.',
      "- main.js:18: TypeError: THREE.Geometry is not a constructor",
      "  FIX: three.js has no Geometry: use THREE.BufferGeometry.",
      "→ Next: fix main.js line 18. The page is checked again when you edit it.",
    ])
  })

  test("a real recording: a missing import names the file, not the script that failed because of it", () => {
    const report = checkReport("coin-run", fixture("check-missing-import")).report
    expect(report).toContain("- enemy.js does not exist, but the page loads or imports it\n  FIX: create enemy.js, or remove the line that loads it.")
    expect(report).not.toContain("could not load")
  })

  test("a real recording: a camera that looks away passes, with the reason nothing shows", () => {
    const { failing, report } = checkReport("coin-run", fixture("check-camera-away"))
    expect(failing).toBe(false)
    expect(report).toContain("Nothing is visible: the screen is one flat color and no object is in front of the camera.")
  })

  test("a wrong name on a line that did not run is still an error", () => {
    const unknown = [{ file: "main.js", line: 60, name: "BoxBufferGeometry", instead: instead("BoxBufferGeometry", exports) }]
    const { failing, report } = checkReport("coin-run", { ...fixture("check-ok"), unknown })
    expect(failing).toBe(true)
    expect(report).toContain("- main.js:60: THREE.BoxBufferGeometry does not exist\n  FIX: three.js has no BoxBufferGeometry: use THREE.BoxGeometry.")
  })

  test("a page that loads but never draws", () => {
    const outcome = fixture("check-ok")
    const report = checkReport("coin-run", { ...outcome, run: { ...outcome.run, frames: 0, drawn: false } }).report
    expect(report).toContain("three.js never drew a frame: nothing calls game.run(...) or renderer.render(scene, camera).")
  })
})

describe("three.js names", () => {
  test("the exports are read from the build", () => {
    expect(exports.has("BoxGeometry")).toBe(true)
    expect(exports.has("WebGLRenderer")).toBe(true)
    expect(exports.has("Geometry")).toBe(false)
  })

  test("names that do not exist are found with their line, comments left alone", () => {
    const source = ["import * as THREE from 'three'", "// THREE.Nothing here", "const a = new THREE.Vector3()", "const b = new THREE.Vector3D(); const c = THREE.Vector3D", "mesh.material = new THREE.MeshToonyMaterial()"].join("\n")
    expect(unknownNames(source, exports)).toEqual([
      { name: "Vector3D", line: 4 },
      { name: "MeshToonyMaterial", line: 5 },
    ])
  })

  test("what to write instead", () => {
    expect(instead("CubeGeometry", exports)).toBe("use THREE.BoxGeometry")
    expect(instead("SphereBufferGeometry", exports)).toBe("use THREE.SphereGeometry")
    expect(instead("MeshToonyMaterial", exports)).toContain("THREE.MeshToonMaterial")
    expect(instead("Rigidbody", exports)).toBe("it is not part of three.js")
  })

  test("known error messages get a fix", () => {
    expect(fixFor('TypeError: Failed to resolve module specifier "three/addons/controls/OrbitControls.js". Relative references must start with either "/", "./", or "../".', exports)).toBe(
      '"three/addons/controls/OrbitControls.js" cannot be imported. Only "three", "kit" and your own files ("./name.js") can.',
    )
    expect(fixFor("ReferenceError: require is not defined", exports)).toContain("use import, not require()")
    expect(fixFor("TypeError: Cannot read properties of undefined", exports)).toBeNull()
  })
})

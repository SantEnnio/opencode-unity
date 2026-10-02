import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findBrowser } from "../src/browser.ts"
import { createPrototypes } from "../src/core.ts"
import { parseWebKeys } from "../src/keys.ts"
import { cleanName, createPrototype, listPrototypes, place, prototypeOf } from "../src/project.ts"

const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-test-")))
const context = (directory: string, sessionID = "s") => ({ directory, sessionID, abort: new AbortController().signal, consent: async () => null })

describe("where prototypes live", () => {
  test("in a plain folder: the folder itself", () => {
    const dir = temp()
    expect(place(dir)).toEqual({ root: dir, engine: null })
  })

  test("in a Unity project, also from a folder inside it: .prototypes at its root", () => {
    const dir = temp()
    fs.mkdirSync(path.join(dir, "ProjectSettings"))
    fs.writeFileSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1\n")
    fs.mkdirSync(path.join(dir, "Assets", "Scripts"), { recursive: true })
    expect(place(dir)).toEqual({ root: path.join(dir, ".prototypes"), engine: "Unity" })
    expect(place(path.join(dir, "Assets", "Scripts"))).toEqual({ root: path.join(dir, ".prototypes"), engine: "Unity" })
  })

  test("in an Unreal project: .prototypes next to the .uproject", () => {
    const dir = temp()
    fs.writeFileSync(path.join(dir, "MyGame.uproject"), "{}")
    expect(place(dir)).toEqual({ root: path.join(dir, ".prototypes"), engine: "Unreal" })
  })

  test("names as a model writes them", () => {
    expect(cleanName("Double Jump")).toBe("double-jump")
    expect(cleanName("  wall_run v2!  ")).toBe("wall-run-v2")
    expect(cleanName("../../etc")).toBe("etc")
    expect(cleanName("???")).toBeNull()
  })

  test("a new prototype is the template plus three.js, and is found again", () => {
    const root = path.join(temp(), ".prototypes")
    const created = createPrototype(root, "double-jump")
    for (const file of ["index.html", "main.js", "vendor/kit.js", "vendor/three.module.js", "vendor/three.core.js", "vendor/three.LICENSE"]) {
      expect(fs.existsSync(path.join(created.dir, file))).toBe(true)
    }
    expect(fs.readFileSync(path.join(created.dir, "index.html"), "utf8")).toContain("<title>double-jump</title>")
    fs.mkdirSync(path.join(root, "not-a-prototype"))
    expect(listPrototypes(root)).toEqual([created])
    expect(prototypeOf(root, path.join(created.dir, "vendor", "kit.js"))).toEqual({ prototype: created, inside: "vendor/kit.js" })
    expect(prototypeOf(root, path.join(root, "not-a-prototype", "main.js"))).toBeNull()
    expect(prototypeOf(root, path.join(root, "..", "Assets", "Player.cs"))).toBeNull()
  })
})

describe("keys", () => {
  test("the script becomes browser keyboard events", () => {
    const parsed = parseWebKeys("W+Shift 2s; space; Up; 1")
    if (typeof parsed === "string") throw new Error(parsed)
    expect(parsed.steps[0]).toEqual({
      keys: [
        { code: "KeyW", key: "w", keyCode: 87 },
        { code: "ShiftLeft", key: "Shift", keyCode: 16 },
      ],
      hold: 2,
      wait: 0,
    })
    expect(parsed.steps.slice(1).map((s) => s.keys[0]!.code)).toEqual(["Space", "ArrowUp", "Digit1"])
    expect(parsed.held).toBeCloseTo(2.3)
  })

  test("the codes a web programmer writes are accepted too", () => {
    const parsed = parseWebKeys("KeyD 1s; ArrowLeft")
    if (typeof parsed === "string") throw new Error(parsed)
    expect(parsed.steps.map((s) => s.keys[0]!.code)).toEqual(["KeyD", "ArrowLeft"])
  })

  test("an unknown key answers with the form to use", () => {
    expect(parseWebKeys("jump")).toContain('Example: "W 2s; Space; W+D 1s; wait 1s"')
  })
})

describe("browser lookup", () => {
  test("Windows: Edge before Chrome, in Program Files", () => {
    const env = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    expect(findBrowser(undefined, "win32", env, (file) => file === edge || file === chrome)).toBe(edge)
    expect(findBrowser(undefined, "win32", env, (file) => file === chrome)).toBe(chrome)
    expect(findBrowser(undefined, "win32", env, () => false)).toBeNull()
  })

  test("macOS, and the configured path first", () => {
    const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    expect(findBrowser(undefined, "darwin", { HOME: "/Users/a" }, (file) => file === edge)).toBe(edge)
    expect(findBrowser("/opt/chromium", "darwin", { HOME: "/Users/a" }, () => true)).toBe("/opt/chromium")
  })
})

describe("core, without a browser", () => {
  const core = (dir: string, options: Record<string, unknown> = {}) => createPrototypes(dir, { checkOnEdit: false, port: 0, ...options }, () => {})!

  test("proto_new creates once, cleans the name, refuses a foreign folder", async () => {
    const dir = temp()
    const proto = core(dir)
    const created = await proto.tools.proto_new!.execute({ name: "Double Jump" }, context(dir))
    expect(created).toContain('[proto] Created "double-jump" in double-jump (three.js r186).')
    expect(created.split("\n").at(-1)).toBe("→ Next: read double-jump/main.js, then change it one small step at a time.")
    expect(await proto.tools.proto_new!.execute({ name: "double-jump" }, context(dir))).toContain('"double-jump" already exists: nothing was created.')
    fs.mkdirSync(path.join(dir, "docs"))
    expect(await proto.tools.proto_new!.execute({ name: "docs" }, context(dir))).toContain("already exists and it is not a prototype")
    expect(await proto.tools.proto_new!.execute({ name: "!!!" }, context(dir))).toContain("has no letters or digits")
    await proto.dispose()
  })

  test("beside a Unity project the prototype goes in .prototypes", async () => {
    const dir = temp()
    fs.mkdirSync(path.join(dir, "ProjectSettings"))
    fs.writeFileSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1\n")
    const proto = core(dir)
    expect(await proto.tools.proto_new!.execute({ name: "grapple" }, context(dir))).toContain("→ Next: read .prototypes/grapple/main.js")
    expect(fs.existsSync(path.join(dir, ".prototypes", "grapple", "main.js"))).toBe(true)
    await proto.dispose()
  })

  test("writes into vendor/ are refused, others are not", async () => {
    const dir = temp()
    const proto = core(dir)
    await proto.tools.proto_new!.execute({ name: "a" }, context(dir))
    expect(proto.guardWrite("edit", { filePath: path.join(dir, "a", "vendor", "kit.js") }, dir)).toContain("[proto] Blocked: vendor/kit.js")
    expect(proto.guardWrite("write", { path: "a/vendor/three.module.js" }, dir)).toContain("Blocked")
    expect(proto.guardWrite("edit", { filePath: path.join(dir, "a", "main.js") }, dir)).toBeNull()
    expect(proto.guardWrite("edit", { filePath: path.join(dir, "vendor", "x.js") }, dir)).toBeNull()
    await proto.dispose()
  })

  test("which prototype a call is about: named, the session's, the only one", async () => {
    const dir = temp()
    const proto = core(dir, { browserPath: "/nonexistent" })
    const play = (args: { name?: string; keys?: string }, sessionID = "s") => proto.tools.proto_play!.execute(args, context(dir, sessionID))
    expect(await play({})).toBe('[proto] There is no prototype yet. Call proto_new with a short name such as "double-jump".')
    await proto.tools.proto_new!.execute({ name: "a" }, context(dir))
    await proto.tools.proto_new!.execute({ name: "b" }, context(dir))
    expect(await play({ name: "c" })).toBe("[proto] No prototype named 'c'. The prototypes are: a, b. Call proto_play again with one of these names.")
    expect(await play({}, "other")).toBe("[proto] There are several prototypes: a, b. Call proto_play again with name set to the one you mean.")
    expect(await play({ keys: "jump" })).toContain("[proto] Game NOT tested: Unknown key 'jump'")
    await proto.dispose()
  })

  test("errors in the user's own tab go with their next two messages, once", async () => {
    const dir = temp()
    const proto = core(dir)
    await proto.tools.proto_new!.execute({ name: "a" }, context(dir))
    const address = /http:\/\/127\.0\.0\.1:\d+/.exec(await proto.tools.proto_status!.execute({}, context(dir)))![0]
    const tab = (events: unknown[]) => fetch(`${address}/__proto/events?page=a`, { method: "POST", body: JSON.stringify({ seconds: 3, frames: 100, visible: true, events }) })

    await tab([])
    proto.userMessage("s", {}, "m1")
    expect(proto.playNote("s")).toBeNull()

    await tab([{ kind: "exception", text: "TypeError: THREE.Geometry is not a constructor", where: "main.js:18", count: 4, first: 1 }])
    proto.userMessage("s", {}, "m2")
    expect(proto.playNote("s")).toEqual({
      messageID: "m2",
      text: [
        '[proto] Recorded by the plugin in the user\'s browser tab while they tried "a": 1 error.',
        "- main.js:18: TypeError: THREE.Geometry is not a constructor (4×)",
        "  FIX: three.js has no Geometry: use THREE.BufferGeometry.",
        "→ Fix these before anything else.",
      ].join("\n"),
    })
    proto.userMessage("s", {}, "m3")
    expect(proto.playNote("s")?.messageID).toBe("m2")
    proto.userMessage("s", {}, "m4")
    expect(proto.playNote("s")).toBeNull()
    await proto.dispose()
  })

  test("the rules reach the prototyper agent anywhere, other agents only where prototypes are the project", async () => {
    const plain = temp()
    const proto = core(plain)
    expect(proto.rules("s")).toBeNull()
    expect(proto.rules("s", "game-prototyper")).toContain("# Game prototype (three.js r186")
    await proto.tools.proto_new!.execute({ name: "a" }, context(plain))
    expect(proto.rules("s", "build")).toContain("Each prototype is a folder: <name>/.")
    await proto.dispose()

    const unity = temp()
    fs.mkdirSync(path.join(unity, "ProjectSettings"))
    fs.writeFileSync(path.join(unity, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1\n")
    const beside = core(unity)
    await beside.tools.proto_new!.execute({ name: "a" }, context(unity))
    expect(beside.rules("s", "unity-coder")).toBeNull()
    expect(beside.rules("s", "game-prototyper")).toContain("Do not change the Unity project's own files.")
    beside.userMessage("s2", { agent: "game-prototyper" })
    expect(beside.rules("s2")).toContain(".prototypes/<name>/")
    await beside.dispose()
  })
})

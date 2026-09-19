import { describe, expect, test } from "bun:test"
import { checkWrite } from "../src/guard.ts"

describe("guard", () => {
  test.each([
    ["Assets/Scripts/Player.cs.meta", "meta"],
    ["Assets\\Scripts\\Player.cs.META", "meta"],
    ["Library/ScriptAssemblies/x.dll", "generated"],
    ["Assembly-CSharp.csproj", "project-files"],
    ["Assets/Scenes/Main.unity", "serialized-asset"],
    ["Assets/Prefabs/Car.prefab", "serialized-asset"],
    ["ProjectSettings/TagManager.asset", "serialized-asset"],
    ["ProjectSettings/ProjectVersion.txt", "project-settings"],
    ["Packages/manifest.json", "package-manifest"],
  ])("blocks %s", (file, rule) => {
    expect(checkWrite(file)?.id).toBe(rule)
  })

  test.each(["Assets/Scripts/Player.cs", "Assets/Scripts/Game.asmdef", "Assets/Shaders/Water.shader", "README.md", "../outside/x.meta"])(
    "allows %s",
    (file) => {
      expect(checkWrite(file)).toBeNull()
    },
  )

  test("rules can be switched off", () => {
    expect(checkWrite("Packages/manifest.json", ["package-manifest"])).toBeNull()
  })
})

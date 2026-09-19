import { describe, expect, test } from "bun:test"
import { cacheDir, hubInstallDirs, parseProjectVersion } from "../src/unity/discovery.ts"

describe("discovery", () => {
  test("reads the editor version from ProjectVersion.txt", () => {
    const content = "m_EditorVersion: 6000.0.71f1\nm_EditorVersionWithRevision: 6000.0.71f1 (907bc2d768b5)\n"
    expect(parseProjectVersion(content)).toBe("6000.0.71f1")
    expect(parseProjectVersion("garbage")).toBeNull()
  })

  test("uses Windows conventions on win32 regardless of the host", () => {
    const env = { ProgramFiles: "D:\\Programs", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }
    expect(hubInstallDirs("win32", env, "C:\\Users\\me")).toEqual(["D:\\Programs\\Unity\\Hub\\Editor"])
    expect(cacheDir("win32", env, "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Local\\opencode-unity")
  })

  test("uses the Hub default on macOS and Linux", () => {
    expect(hubInstallDirs("darwin", {}, "/Users/me")).toContain("/Applications/Unity/Hub/Editor")
    expect(hubInstallDirs("linux", {}, "/home/me")).toContain("/home/me/Unity/Hub/Editor")
    expect(cacheDir("linux", { XDG_CACHE_HOME: "/x" }, "/home/me")).toBe("/x/opencode-unity")
  })
})

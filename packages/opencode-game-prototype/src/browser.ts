// The browser that runs a prototype with no window: Edge or Chrome, already on the machine. Nothing
// is installed. One process per run, with a throwaway profile, killed when the run is over: a
// browser kept alive between runs would outlive a crashed opencode.

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { which } from "../../opencode-unity/src/runtime.ts"

type Env = Record<string, string | undefined>

function candidates(platform: NodeJS.Platform, env: Env): string[] {
  if (platform === "win32") {
    const bases = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter((base): base is string => Boolean(base))
    // Edge first: it is part of Windows, so it is there even on a locked-down machine.
    return [
      ...bases.map((base) => path.win32.join(base, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...bases.map((base) => path.win32.join(base, "Google", "Chrome", "Application", "chrome.exe")),
    ]
  }
  if (platform === "darwin") {
    const apps = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Chromium.app/Contents/MacOS/Chromium"]
    // posix on purpose, like win32 above: the paths of the platform asked for, whatever runs this.
    return ["/Applications", path.posix.join(env.HOME ?? "", "Applications")].flatMap((base) => apps.map((app) => path.posix.join(base, app)))
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]
    .map((command) => which(command, env))
    .filter((found): found is string => found !== null)
}

/** `configured` is the browserPath option: used as given when it exists. */
export function findBrowser(configured?: string, platform: NodeJS.Platform = process.platform, env: Env = process.env, exists: (file: string) => boolean = fs.existsSync): string | null {
  if (configured && exists(configured)) return configured
  return candidates(platform, env).find(exists) ?? null
}

const FLAGS = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-component-update",
  "--mute-audio",
  "--window-size=1280,720",
  // The page is on this machine: the school's proxy has nothing to do with it.
  "--no-proxy-server",
  // A window nobody sees is throttled like a background tab; the game must run in real time.
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  // Without a GPU (a virtual machine, a CI runner) WebGL still works, drawn in software.
  "--enable-unsafe-swiftshader",
]

const live = new Set<ChildProcess>()
let exitHook = false

function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === "win32") {
    // The browser is a tree of processes: a plain kill leaves the renderers behind.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {})
  } else {
    child.kill("SIGKILL")
  }
}

export type Headless = {
  /** Resolves when the browser process is gone, whoever ended it */
  exited: Promise<void>
  close(): void
}

export function launchHeadless(browser: string, url: string): Headless {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-game-prototype-"))
  const child = spawn(browser, [...FLAGS, `--user-data-dir=${profile}`, url], { stdio: "ignore", windowsHide: true })
  live.add(child)
  if (!exitHook) {
    exitHook = true
    process.on("exit", () => live.forEach(kill))
  }
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      live.delete(child)
      // The profile is locked for a moment after the process ends, on Windows above all.
      fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }, () => resolve())
    }
    child.once("exit", done)
    child.once("error", done)
  })
  return { exited, close: () => kill(child) }
}

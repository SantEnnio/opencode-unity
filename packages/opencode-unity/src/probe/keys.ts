// The key script of a test play, as a small model writes it: "W 2s; Space; W+D 1s; wait 1s".
// Parsed forgivingly, and turned into the Input System's Key names the probe presses.

export type KeyStep = { keys: string[]; hold: number; wait: number }

const TAP = 0.1
const MAX_TOTAL = 20

const ALIASES: Record<string, string> = {
  space: "Space", spacebar: "Space",
  enter: "Enter", return: "Enter",
  esc: "Escape", escape: "Escape",
  tab: "Tab", backspace: "Backspace", delete: "Delete", del: "Delete",
  shift: "LeftShift", lshift: "LeftShift", leftshift: "LeftShift", rshift: "RightShift", rightshift: "RightShift",
  ctrl: "LeftCtrl", control: "LeftCtrl", lctrl: "LeftCtrl", leftctrl: "LeftCtrl", rctrl: "RightCtrl", rightctrl: "RightCtrl",
  alt: "LeftAlt", lalt: "LeftAlt", leftalt: "LeftAlt", ralt: "RightAlt", rightalt: "RightAlt",
  up: "UpArrow", uparrow: "UpArrow", arrowup: "UpArrow",
  down: "DownArrow", downarrow: "DownArrow", arrowdown: "DownArrow",
  left: "LeftArrow", leftarrow: "LeftArrow", arrowleft: "LeftArrow",
  right: "RightArrow", rightarrow: "RightArrow", arrowright: "RightArrow",
}

export function keyName(raw: string): string | null {
  const text = raw.trim().replace(/^key\s*/i, "")
  const compact = text.toLowerCase().replace(/[\s_-]+/g, "")
  if (/^[a-z]$/.test(compact)) return compact.toUpperCase()
  if (/^[0-9]$/.test(compact)) return `Digit${compact}`
  if (/^f([1-9]|1[0-2])$/.test(compact)) return compact.toUpperCase()
  return ALIASES[compact] ?? null
}

/** "2s", "2", "2.5 s", "500ms" -> seconds */
function seconds(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)?$/i.exec(text.trim())
  if (!match) return null
  const value = Number(match[1])
  return match[2]?.toLowerCase() === "ms" ? value / 1000 : value
}

const EXAMPLE = 'Example: "W 2s; Space; W+D 1s; wait 1s". Keys: letters, digits, Space, Enter, Escape, Tab, Shift, Ctrl, Alt, Up, Down, Left, Right, F1-F12. Join keys held together with +. A time after the keys holds them; without a time, a quick tap.'

/** The steps, or a message saying what could not be read and how to write it. */
export function parseKeys(script: string): { steps: KeyStep[]; total: number; text: string } | string {
  const parts = script.split(/[;,\n]+/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return `No keys given. ${EXAMPLE}`
  const steps: KeyStep[] = []
  for (const part of parts) {
    const wait = /^(?:wait|pause|sleep)\s+(.+)$/i.exec(part)
    if (wait) {
      const time = seconds(wait[1]!)
      if (time === null) return `'${part}': a wait needs a time such as "wait 1s". ${EXAMPLE}`
      steps.push({ keys: [], hold: 0, wait: time })
      continue
    }
    const match = /^(.+?)(?:\s+(?:for\s+)?(\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?)?))?$/i.exec(part)!
    const names = match[1]!.split("+").map((k) => k.trim()).filter(Boolean)
    const keys = names.map(keyName)
    const unknown = names.filter((_, i) => keys[i] === null)
    if (unknown.length > 0) return `Unknown key ${unknown.map((k) => `'${k}'`).join(", ")} in '${part}'. ${EXAMPLE}`
    const hold = match[2] ? seconds(match[2])! : TAP
    steps.push({ keys: keys as string[], hold, wait: 0 })
  }
  const total = steps.reduce((sum, s) => sum + (s.keys.length > 0 ? s.hold + 0.1 : s.wait), 0)
  if (total > MAX_TOTAL) return `The keys add up to ${total.toFixed(1)} s; a test play is at most ${MAX_TOTAL} s. Test one thing per call.`
  const text = steps.map((s) => (s.keys.length === 0 ? `wait ${s.wait}s` : `${s.keys.join("+")}${s.hold === TAP ? "" : ` ${s.hold}s`}`)).join("; ")
  return { steps, total, text }
}

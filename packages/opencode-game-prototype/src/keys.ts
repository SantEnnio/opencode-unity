// The key script of a test play, in the same words as opencode-unity ("W 2s; Space; W+D 1s; wait 1s"),
// turned into what a browser's keyboard events carry.

import { parseKeys } from "../../opencode-unity/src/probe/keys.ts"

export type WebKey = { code: string; key: string; keyCode: number }
export type WebStep = { keys: WebKey[]; hold: number; wait: number }

const NAMED: Record<string, WebKey> = {
  Space: { code: "Space", key: " ", keyCode: 32 },
  Enter: { code: "Enter", key: "Enter", keyCode: 13 },
  Escape: { code: "Escape", key: "Escape", keyCode: 27 },
  Tab: { code: "Tab", key: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", key: "Delete", keyCode: 46 },
  LeftShift: { code: "ShiftLeft", key: "Shift", keyCode: 16 },
  RightShift: { code: "ShiftRight", key: "Shift", keyCode: 16 },
  LeftCtrl: { code: "ControlLeft", key: "Control", keyCode: 17 },
  RightCtrl: { code: "ControlRight", key: "Control", keyCode: 17 },
  LeftAlt: { code: "AltLeft", key: "Alt", keyCode: 18 },
  RightAlt: { code: "AltRight", key: "Alt", keyCode: 18 },
  UpArrow: { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
  DownArrow: { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
  LeftArrow: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
  RightArrow: { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
}

function webKey(name: string): WebKey {
  if (/^[A-Z]$/.test(name)) return { code: `Key${name}`, key: name.toLowerCase(), keyCode: name.charCodeAt(0) }
  const digit = /^Digit(\d)$/.exec(name)
  if (digit) return { code: name, key: digit[1]!, keyCode: 48 + Number(digit[1]) }
  const fn = /^F(\d+)$/.exec(name)
  if (fn) return { code: name, key: name, keyCode: 111 + Number(fn[1]) }
  return NAMED[name]!
}

/** The steps, or a message saying what could not be read and how to write it. */
export function parseWebKeys(script: string): { steps: WebStep[]; total: number; held: number; text: string } | string {
  const parsed = parseKeys(script)
  if (typeof parsed === "string") return parsed
  return {
    steps: parsed.steps.map((step) => ({ keys: step.keys.map(webKey), hold: step.hold, wait: step.wait })),
    total: parsed.total,
    held: parsed.steps.reduce((sum, step) => sum + (step.keys.length > 0 ? step.hold : 0), 0),
    text: parsed.text,
  }
}

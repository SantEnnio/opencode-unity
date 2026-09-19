// Mistakes the C# compiler accepts but Unity does not: they compile, then silently do nothing
// (a misspelled Update), break the player build (UnityEditor in runtime code) or tank the
// frame rate. Regex-based on purpose: fast, dependency-free, and wrong only in harmless ways.

import { levenshtein } from "./enrich.ts"

export type LintFinding = { line: number; rule: string; message: string }

export type LintContext = {
  /** Project-relative path, forward slashes */
  file: string
  /** ProjectSettings activeInputHandler: 0 old Input Manager, 1 Input System package, 2 both */
  inputHandler: 0 | 1 | 2 | null
}

// message name -> required parameter type (null: no parameters or not checked)
const MESSAGES: Record<string, string | null> = {
  Awake: null, Start: null, Update: null, FixedUpdate: null, LateUpdate: null, OnEnable: null, OnDisable: null,
  OnDestroy: null, OnValidate: null, Reset: null, OnGUI: null, OnApplicationQuit: null, OnApplicationPause: null,
  OnApplicationFocus: null, OnBecameVisible: null, OnBecameInvisible: null, OnDrawGizmos: null,
  OnDrawGizmosSelected: null, OnAnimatorMove: null, OnAnimatorIK: null, OnRenderObject: null, OnPreRender: null,
  OnPostRender: null, OnWillRenderObject: null, OnTransformParentChanged: null, OnTransformChildrenChanged: null,
  OnMouseDown: null, OnMouseUp: null, OnMouseEnter: null, OnMouseExit: null, OnMouseOver: null, OnMouseDrag: null,
  OnMouseUpAsButton: null, OnParticleCollision: "GameObject", OnParticleTrigger: null, OnJointBreak: "float",
  OnControllerColliderHit: "ControllerColliderHit",
  OnCollisionEnter: "Collision", OnCollisionStay: "Collision", OnCollisionExit: "Collision",
  OnCollisionEnter2D: "Collision2D", OnCollisionStay2D: "Collision2D", OnCollisionExit2D: "Collision2D",
  OnTriggerEnter: "Collider", OnTriggerStay: "Collider", OnTriggerExit: "Collider",
  OnTriggerEnter2D: "Collider2D", OnTriggerStay2D: "Collider2D", OnTriggerExit2D: "Collider2D",
}
const MESSAGE_NAMES = Object.keys(MESSAGES)
const HOT_METHODS = new Set(["Update", "FixedUpdate", "LateUpdate", "OnGUI"])
const EXPENSIVE_CALLS =
  /\b(GetComponent(?:s|InChildren|InParent|sInChildren|sInParent)?\s*<|GameObject\.Find(?:WithTag|GameObjectsWithTag)?\s*\(|Find(?:First|Any)?Objects?(?:By|Of)Type\s*[<(]|Resources\.Load\s*[<(]|Camera\.main\b)/

/** Blanks out comments and string literals, keeping every offset and line break in place. */
export function maskCode(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|@"(?:[^"]|"")*"|\$?"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/g, (m) =>
    m.replace(/[^\n]/g, " "),
  )
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length

/** Offset just past the block that opens at the first "{" found from `from`. */
function blockEnd(code: string, from: number): number {
  const open = code.indexOf("{", from)
  if (open < 0) return code.length
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++
    else if (code[i] === "}" && --depth === 0) return i + 1
  }
  return code.length
}

const METHOD = /(?:^|[;{}\]])\s*((?:(?:public|private|protected|internal|static|virtual|override|async|new|sealed|unsafe)\s+)*)([A-Za-z_][\w<>\[\],.?]*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?=\{|=>)/g

export function lintSource(source: string, context: LintContext): LintFinding[] {
  const code = maskCode(source)
  const findings: LintFinding[] = []
  const add = (index: number, rule: string, message: string) => findings.push({ line: lineOf(code, index), rule, message })

  const behaviours = [...code.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*:\s*([^{]+)\{/g)]
  const isMonoBehaviour = behaviours.some((m) => /\b(MonoBehaviour|NetworkBehaviour)\b/.test(m[2]!))
  const inEditorFolder = /(^|\/)editor\//i.test(context.file)

  // Unity attaches scripts by file name: the class must match it.
  const fileName = context.file.slice(context.file.lastIndexOf("/") + 1).replace(/\.cs$/i, "")
  const attachable = behaviours.filter((m) => /\b(MonoBehaviour|ScriptableObject|NetworkBehaviour)\b/.test(m[2]!))
  if (attachable.length > 0 && !attachable.some((m) => m[1] === fileName)) {
    const first = attachable[0]!
    add(first.index, "class-file-name", `Class '${first[1]}' must have the same name as its file ('${fileName}.cs'), or Unity cannot attach it to a GameObject. Rename the class to '${fileName}' or the file to '${first[1]}.cs'.`)
  }

  const coroutines = new Set<string>()
  const methods = [...code.matchAll(METHOD)].map((m) => {
    const nameIndex = m.index + m[0].lastIndexOf(m[3]!)
    return { returnType: m[2]!, name: m[3]!, params: m[4]!.trim(), index: nameIndex, end: blockEnd(code, m.index + m[0].length - 1) }
  })
  for (const method of methods) if (method.returnType === "IEnumerator") coroutines.add(method.name)

  if (isMonoBehaviour) {
    for (const method of methods) {
      const expected = MESSAGES[method.name]
      if (expected === undefined) {
        // Not a Unity message: is it a near miss of one? (update, OnColisionEnter, OnTriggerenter)
        if (method.returnType !== "void" && method.returnType !== "IEnumerator") continue
        const lower = method.name.toLowerCase()
        const near = MESSAGE_NAMES.find(
          (name) => name.toLowerCase() === lower || (name.length > 6 && Math.abs(name.length - method.name.length) <= 2 && levenshtein(name, method.name) <= 2),
        )
        if (near) add(method.index, "message-typo", `'${method.name}' is never called by Unity. The message is spelled '${near}' (exact case). Rename it.`)
        continue
      }
      if (expected && method.params.length > 0) {
        const actual = method.params.split(/\s+/)[0]!.replace(/^UnityEngine\./, "")
        if (actual !== expected) add(method.index, "message-signature", `${method.name} must take a '${expected}' parameter, not '${actual}', or Unity will not call it: void ${method.name}(${expected} other)`)
      } else if (expected && /^On(Collision|Trigger)/.test(method.name) && method.params.length === 0) {
        add(method.index, "message-signature", `${method.name} needs its parameter to be useful: void ${method.name}(${expected} other)`)
      }

      if (HOT_METHODS.has(method.name)) {
        const body = code.slice(method.index, method.end)
        const hit = EXPENSIVE_CALLS.exec(body)
        if (hit) add(method.index + hit.index, "expensive-in-update", `${hit[1]!.replace(/[\s<(]+$/, "")} runs every frame inside ${method.name}. Do the lookup once in Awake/Start, store it in a field, and use the field here.`)
      }
    }
  }

  // A coroutine called like a normal method does nothing.
  for (const name of coroutines) {
    for (const call of code.matchAll(new RegExp(`(?:^|[;{}])\\s*(?:this\\.)?${name}\\s*\\([^;]*\\)\\s*;`, "g"))) {
      add(call.index + call[0].indexOf(name), "coroutine-not-started", `${name} is a coroutine (returns IEnumerator): calling it directly runs nothing. Use StartCoroutine(${name}(...)).`)
    }
  }

  if (!inEditorFolder) {
    const usingEditor = /^\s*using\s+UnityEditor\b[^;]*;/m.exec(code)
    if (usingEditor && !/#if\s+UNITY_EDITOR/.test(source)) {
      add(usingEditor.index, "editor-in-runtime", "`using UnityEditor` in a runtime script breaks the player build. Move this script under a folder named Editor/, or wrap the editor-only code (and the using) in #if UNITY_EDITOR ... #endif.")
    }
  }

  if (context.inputHandler === 1) {
    const legacy = /\bInput\.(GetKey(?:Down|Up)?|GetAxis(?:Raw)?|GetButton(?:Down|Up)?|GetMouseButton(?:Down|Up)?|mousePosition|touches|GetTouch)\b/.exec(code)
    if (legacy) add(legacy.index, "legacy-input", `This project uses the Input System package only: UnityEngine.Input.${legacy[1]} throws at runtime. Use UnityEngine.InputSystem (e.g. Keyboard.current.spaceKey.wasPressedThisFrame, Mouse.current.position.ReadValue(), or an InputAction).`)
  } else if (context.inputHandler === 0) {
    const modern = /^\s*using\s+UnityEngine\.InputSystem\b/m.exec(code)
    if (modern) add(modern.index, "input-system-disabled", "This project uses the old Input Manager (Active Input Handling = Input Manager): the Input System package is not active. Use UnityEngine.Input (Input.GetKey, Input.GetAxis) or ask the user to switch Active Input Handling.")
  }

  return findings.sort((a, b) => a.line - b.line)
}

export function parseInputHandler(projectSettings: string): 0 | 1 | 2 | null {
  const value = /^\s*activeInputHandler:\s*(\d)/m.exec(projectSettings)?.[1]
  return value === "0" || value === "1" || value === "2" ? (Number(value) as 0 | 1 | 2) : null
}

export function renderLint(findings: { file: string; finding: LintFinding }[]): string {
  if (findings.length === 0) return ""
  const lines = [`[unity] ${findings.length} Unity-specific problem${findings.length === 1 ? "" : "s"} the compiler does not catch. Fix them too:`]
  findings.forEach(({ file, finding }, i) => lines.push(`${i + 1}) ${file}:${finding.line}  ${finding.message}`))
  return lines.join("\n")
}

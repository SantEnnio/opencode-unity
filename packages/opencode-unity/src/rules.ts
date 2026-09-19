// The always-on context. Deliberately tiny: a small model follows fifteen lines and ignores
// a hundred. Everything that can be enforced by a hook is enforced there instead of here.

import fs from "node:fs"
import path from "node:path"
import { parseInputHandler } from "./lint.ts"
import type { UnityProject } from "./unity/discovery.ts"

export type ProjectFacts = {
  version: string
  inputHandler: 0 | 1 | 2 | null
  renderPipeline: "URP" | "HDRP" | "Built-in"
  packages: string[]
}

const NOTABLE_PACKAGES: Record<string, string> = {
  "com.unity.inputsystem": "Input System",
  "com.unity.cinemachine": "Cinemachine",
  "com.unity.textmeshpro": "TextMeshPro",
  "com.unity.ugui": "uGUI",
  "com.unity.addressables": "Addressables",
  "com.unity.netcode.gameobjects": "Netcode for GameObjects",
  "com.unity.entities": "Entities (DOTS)",
  "com.unity.xr.interaction.toolkit": "XR Interaction Toolkit",
  "com.unity.ai.navigation": "AI Navigation",
  "com.unity.timeline": "Timeline",
  "com.unity.test-framework": "Test Framework",
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

export function projectFacts(project: UnityProject): ProjectFacts {
  let dependencies: Record<string, string> = {}
  try {
    dependencies = JSON.parse(read(path.join(project.root, "Packages", "manifest.json"))).dependencies ?? {}
  } catch {
    // no manifest: report nothing rather than guess
  }
  return {
    version: project.version,
    inputHandler: parseInputHandler(read(path.join(project.root, "ProjectSettings", "ProjectSettings.asset"))),
    renderPipeline: "com.unity.render-pipelines.universal" in dependencies ? "URP" : "com.unity.render-pipelines.high-definition" in dependencies ? "HDRP" : "Built-in",
    packages: Object.keys(NOTABLE_PACKAGES).filter((id) => id in dependencies).map((id) => NOTABLE_PACKAGES[id]!),
  }
}

const INPUT_RULE = {
  0: "Input: old Input Manager only. Use UnityEngine.Input (Input.GetKey, Input.GetAxis). Do not use UnityEngine.InputSystem.",
  1: "Input: Input System package only. Use UnityEngine.InputSystem (Keyboard.current, Mouse.current, InputAction). UnityEngine.Input throws at runtime.",
  2: "Input: both the old Input Manager and the Input System package are enabled.",
}

export function renderRules(facts: ProjectFacts): string {
  const lines = [
    `# Unity project (Unity ${facts.version}, ${facts.renderPipeline} render pipeline)`,
    facts.packages.length > 0 ? `Installed packages: ${facts.packages.join(", ")}.` : "",
    facts.inputHandler !== null ? INPUT_RULE[facts.inputHandler] : "",
    "",
    "Rules:",
    "- Every edit of a .cs file is compiled automatically. Read the [unity] report in the tool result: if it lists errors, fix them before anything else, using the FIX lines.",
    "- Never invent a Unity API. If you are not certain a type or member exists, call unity_lookup first. For how-to questions call unity_docs_search.",
    "- One MonoBehaviour or ScriptableObject per file, class name = file name. Scripts go under Assets/. Editor-only code goes in a folder named Editor/.",
    "- Use [SerializeField] private fields instead of public fields for Inspector values. Cache GetComponent results in Awake/Start, never in Update.",
    "- Do not create or edit .meta files, scenes, prefabs, .asset files, ProjectSettings/ or Packages/manifest.json: those writes are blocked. Change things from C#, or tell the user what to do in the Editor.",
    "- Scenes: look with unity_scene_view, change with unity_scene_edit (objects, components, values, references). Never write an Editor script just to build a scene. If those tools say no Editor is connected, tell the user exactly what to set up by hand.",
  ]
  return lines.filter((line, i) => line !== "" || i === 3).join("\n")
}

export const AGENT_PROMPT = `You are a careful Unity C# programmer. You write small, correct changes and you verify them.

Work in this loop:
1. Read the files you are going to change. Look up any Unity API you are not sure about with unity_lookup.
2. Make one focused edit at a time.
3. Read the [unity] compile report that comes back with the edit. If it FAILED, fix every listed error using the FIX lines, then continue.
4. Scene work (objects, components, Inspector values, references) goes through unity_scene_view and unity_scene_edit, after the scripts compile.
5. When the task is done and the last report says "passed", stop and summarise: what you changed, and anything the user still has to do in the Unity Editor.

Never claim the work is finished while the last compile report lists errors. Never guess API names: look them up.`

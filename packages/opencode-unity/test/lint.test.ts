import { describe, expect, test } from "bun:test"
import { lintSource, maskCode, parseInputHandler } from "../src/lint.ts"

const lint = (source: string, file = "Assets/Scripts/Player.cs", inputHandler: 0 | 1 | 2 | null = 2) =>
  lintSource(source, { file, inputHandler }).map((f) => f.rule)

const behaviour = (body: string, name = "Player") => `using UnityEngine;\npublic class ${name} : MonoBehaviour\n{\n${body}\n}\n`

describe("lint", () => {
  test("clean script has no findings", () => {
    const source = behaviour(`
    Rigidbody rb;
    void Awake() { rb = GetComponent<Rigidbody>(); }
    void Update() { rb.AddForce(Vector3.up); }
    void OnCollisionEnter(Collision other) { Debug.Log("Update() GetComponent<X>() inside a string"); }`)
    expect(lint(source)).toEqual([])
  })

  test("misspelled Unity messages", () => {
    expect(lint(behaviour("void update() {}"))).toEqual(["message-typo"])
    expect(lint(behaviour("void OnColisionEnter(Collision c) {}"))).toEqual(["message-typo"])
    expect(lint(behaviour("void UpdateScore() {}\nvoid Started() {}"))).toEqual([])
  })

  test("wrong message parameter type", () => {
    expect(lint(behaviour("void OnTriggerEnter(Collision other) {}"))).toEqual(["message-signature"])
    expect(lint(behaviour("void OnTriggerEnter2D(Collider2D other) {}"))).toEqual([])
  })

  test("expensive lookups in per-frame methods, ignoring comments", () => {
    expect(lint(behaviour("void Update() { var rb = GetComponent<Rigidbody>(); }"))).toEqual(["expensive-in-update"])
    expect(lint(behaviour("void Update() { // GetComponent<Rigidbody>()\n }"))).toEqual([])
    expect(lint(behaviour("void Start() { var c = Camera.main; }"))).toEqual([])
  })

  test("class name must match file name", () => {
    expect(lint(behaviour("", "Enemy"))).toEqual(["class-file-name"])
    expect(lint("public class Helper { }", "Assets/Scripts/Util.cs")).toEqual([])
  })

  test("coroutine called without StartCoroutine", () => {
    const source = behaviour("System.Collections.IEnumerator Fade() { yield return null; }\nvoid Start() { Fade(); }".replace("System.Collections.", ""))
    expect(lint(source)).toEqual(["coroutine-not-started"])
    expect(lint(behaviour("IEnumerator Fade() { yield return null; }\nvoid Start() { StartCoroutine(Fade()); }"))).toEqual([])
  })

  test("UnityEditor in runtime code", () => {
    expect(lint("using UnityEditor;\npublic class Tool { }", "Assets/Scripts/Tool.cs")).toEqual(["editor-in-runtime"])
    expect(lint("using UnityEditor;\npublic class Tool { }", "Assets/Scripts/Editor/Tool.cs")).toEqual([])
    expect(lint("#if UNITY_EDITOR\nusing UnityEditor;\n#endif\npublic class Tool { }", "Assets/Scripts/Tool.cs")).toEqual([])
  })

  test("input API must match the project's active input handler", () => {
    const legacy = behaviour("void Update() { if (Input.GetKeyDown(KeyCode.Space)) {} }")
    expect(lint(legacy, "Assets/Scripts/Player.cs", 1)).toEqual(["legacy-input"])
    expect(lint(legacy, "Assets/Scripts/Player.cs", 2)).toEqual([])
    expect(lint("using UnityEngine.InputSystem;\npublic class A { }", "Assets/A.cs", 0)).toEqual(["input-system-disabled"])
  })

  test("helpers", () => {
    expect(maskCode('a = "x // y"; // z').trimEnd()).toBe(`a = ${" ".repeat(8)};`)
    expect(parseInputHandler("  activeInputHandler: 1\n")).toBe(1)
    expect(parseInputHandler("nothing")).toBeNull()
  })
})

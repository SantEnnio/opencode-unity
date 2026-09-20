# opencode-unity

Guardrails for small/local models working on Unity projects in [opencode](https://opencode.ai).

Small models plan well but write Unity code from memory: APIs that never existed, APIs that were
renamed in Unity 6, missing `using` directives. They also do not go and check. This plugin does
the checking for them, deterministically, and puts the answer where they cannot miss it: in the
result of the edit they just made.

## Install

Requirements: the .NET SDK (6.0 or newer) on `PATH`, and the project's Unity Editor version
installed through Unity Hub (or `UNITY_EDITOR_PATH` pointing at it).

Add the plugin to your opencode config (`~/.config/opencode/opencode.json` for every project, or
`opencode.json` in one project) and restart opencode (CLI or desktop):

```json
{
  "plugin": ["opencode-unity"]
}
```

The plugin activates when the opened folder is, contains, or sits inside a Unity project, and
does nothing anywhere else.

**Is it on?** Open a Unity project and type `/unity`: the plugin reports that it is active, what
it found (Unity version, Editor install, .NET SDK, docs, Unity CLI) and which route compile, tests
and console will take. The `unity-coder` agent also appears in the agent list, only in Unity
projects. At startup it writes one line to the opencode log (`opencode-unity x.y.z active: ...`).

From a clone of this repository instead (needs [Bun](https://bun.sh)):

```sh
cd packages/opencode-unity
bun install
bun run install:global      # bun run uninstall:global to remove
```

This bundles the plugin into `~/.config/opencode/plugins/opencode-unity.js`, with its assets in
`~/.config/opencode/opencode-unity/`.

The offline documentation is optional and installed once per Unity release stream (about 400 MB
download, ~60 MB on disk afterwards): ask the model to call `unity_docs_install`, set
`"docs": "auto"` in the options, or run `bunx opencode-unity docs install 6000.0`.

## What it does

**On every edit of a `.cs` file** (no tool call needed from the model):

- The project is compiled with `dotnet build` on the Unity-generated projects: 2-5 s, works while
  the Editor is open. Scripts created or deleted since Unity last regenerated the `.csproj` files
  are reconciled on the fly.
- Compiler errors are matched against a symbol graph built from the DLLs of the exact Editor
  version, plus the project's packages (`Library/ScriptAssemblies`):

  | Error | Hint appended to the edit result |
  |---|---|
  | CS1061 / CS0117 member does not exist | closest real members with signatures; all values for enums |
  | CS0246 / CS0103 type not found | the `using` to add, or "this type does not exist" |
  | CS0618 / CS0619 obsolete | the replacement from `[Obsolete]`, with its signature |
  | CS1501 / CS1503 / CS7036 wrong arguments | the real overloads, narrowed to the receiver's type |
  | CS0122 inaccessible | what to change |

- Unity-specific lints the compiler cannot do: misspelled messages (`update`, `OnColisionEnter`),
  wrong message parameter types, `GetComponent`/`Find` in `Update`, class name ≠ file name,
  coroutines called without `StartCoroutine`, `UnityEditor` in runtime code, input API that does
  not match the project's Active Input Handling.

**Guards**

- Writes to `.meta`, `Library/`, scenes/prefabs/assets (YAML), `ProjectSettings/`,
  `Packages/manifest.json` and generated project files are blocked, with what to do instead
  (for scenes: the scene tools below).
- Idle gate: if the model stops while the build is red, it is sent back to fix the errors
  (twice at most per user message).

**Tools**

| Tool | Purpose |
|---|---|
| `unity_status` (`/unity`) | Is the plugin active, what did it find, which routes are available |
| `unity_lookup` | Fuzzy API lookup: signatures, overloads, obsolete → replacement, example from the docs |
| `unity_docs_search` / `unity_docs_read` | Offline Manual + Scripting Reference + docs of the installed packages (SQLite FTS5) |
| `unity_docs_install` | Background download + indexing of the offline documentation |
| `unity_scene_view`, `unity_object_*`, `unity_component_*`, `unity_prefab_*`, `unity_scene_save` | Read and change the open scene through the Editor: objects, components, values, references, prefabs. One flat tool per action, validated before anything is touched (see below) |
| `unity_pipeline_install` | Adds the Pipeline package to the project, after the user approves the permission prompt |
| `unity_compile` | Explicit check. Uses Unity's own compiler when it can (see below) |
| `unity_test` | EditMode/PlayMode tests, failures only |
| `unity_console` | Console of the open Editor (runtime errors, stack traces) |
| `unity_run_method` | `-executeMethod` for a whitelist of methods (only registered when `executeMethods` is set) |

**Context**: a ~12 line rules block with the project's facts (Unity version, render pipeline,
input handling, notable packages) is added to the system prompt, and a `unity-coder` agent
(low temperature, edit → read report → fix loop) is registered.

## The open Editor: scenes, Console, tests

A model that cannot touch the scene ends up writing throwaway Editor scripts that build it, or,
worse, editing the `.unity` YAML by hand. The plugin blocks the YAML and gives it a real tool
instead, by talking to the Editor you already have open.

This needs Unity's **Pipeline package** (`com.unity.pipeline`, experimental) in the project. Just
ask the agent ("install the Pipeline package"): it calls `unity_pipeline_install`, opencode shows a
permission prompt, and only after you approve does the tool run `unity pipeline install` for the
project (it needs the official Unity CLI). Or run that command yourself in the project folder.

The package is never installed without that approval: it changes `Packages/manifest.json`. If the
Editor is open, click its window afterwards so it imports the package. `/unity` tells you whether
the package is installed and connected. Once it is, the plugin talks to the package's local HTTP
server directly (loopback only, token from `Library/Pipeline/`), so calls take milliseconds.

**`unity_scene_view`** shows the hierarchy as a tree with each object's components, or, given a
path, every component of one object with its current values (shown with the names a programmer
would type: `mass`, not `m_Mass`).

**Changing the scene: one flat tool per action.** A small model is never asked for nested JSON.
A vector is `"0, 1.5, -3"`, values are `"mass=1500; useGravity=true; target=/Car"`, a color is
`red` or `#E53935`:

| Tool | Arguments |
|---|---|
| `unity_object_create` | `name`, `shape` (cube, sphere, capsule, cylinder, plane, quad, or none for a group), `parent`, `position`, `rotation`, `scale`, `color`, `components` |
| `unity_object_modify` | `path`, then any of `position`, `rotation`, `scale`, `color`, `tag`, `layer`, `active`, `new_name`, `new_parent` |
| `unity_object_delete` | `path` |
| `unity_component_add` | `path`, `component`, optional `values` |
| `unity_component_set` | `path`, `component`, `values` |
| `unity_component_remove` | `path`, `component` |
| `unity_prefab_create` | `path` of a scene object, optional `prefab` asset path. Build a thing once, reuse it |
| `unity_prefab_place` | `prefab`, `name`, `parent`, `position`, `rotation` |
| `unity_scene_save` | none |

Why flat: in a real session qwen3.6-35b-a3b wrote a list of operations correctly into a *file*,
then broke the very same JSON, at the very same key, every time it had to go inside a tool
argument. Simple calls always worked. So the default surface is simple calls. Object-reference
values take a scene path (`target=/Car`, resolved to the field's type: Transform, Rigidbody,
GameObject...) or an asset path (`material=Assets/Materials/Red.mat`). `color` writes a material
for that object under `Assets/Materials/` and assigns it. Successful calls end with a pointer to
the next sensible step.

Stronger models can use **`unity_scene_edit`** instead, a single tool that takes a list of
operations and applies them as one transaction (set `"sceneTools": "batch"`, or `"both"`):

```json
{ "operations": [
  { "op": "create", "name": "Car" },
  { "op": "create", "name": "Body", "parent": "/Car", "primitive": "cube", "scale": [1.2, 0.5, 2.2], "color": "red" },
  { "op": "add_component", "target": "/Car", "type": "Rigidbody", "values": { "mass": 1500 } }
] }
```

What makes it safe for a small model, whichever surface is used:

- **Everything is validated before the scene is touched**, with the fix in the message: unknown
  component (`RigidBody` → did you mean `Rigidbody`), unknown property (with the list of real
  ones), missing object (closest paths), tag or layer that does not exist, duplicate names, a value
  of the wrong kind, an asset that does not exist or that Unity cannot import (hand-written YAML).
  Property names are matched the way they are written in code, including names that changed
  (`linearDamping` still serializes as `m_Drag` in Unity 6000.0).
- **Input is forgiving.** Invented type wrappers (`{"$float": 1500}`), vectors as `{x, y, z}`,
  colors as 0-255, misspelled keys, and, for the batch tool, the nestings small models produce
  (`{"create": {...}}`, `{"op": {...}}`). Each of these came from a real failed call and is now a
  regression test.
- **No silent no-ops**: a field that cannot be understood is an error, never ignored.
- **Loops are cut**: the second identical failing call is called out, from the third on it is not
  executed and the model is told to stop and talk to the user. (A call Unity rejects also leaves an
  error in the user's Console, so not repeating it matters.)
- **One Undo step per call**; the batch tool is all-or-nothing.
- **Nothing is saved unless asked.**
- A warning when a child is created under a non-uniformly scaled parent (it would be stretched),
  with the usual fix: an empty group plus scaled shapes inside it.
- Blocked in Play mode (by the package). User scripts can be added as components once they compile.

Also through the open Editor: `unity_compile` triggers a real recompile and reads Unity's
verdict, `unity_console` reads the Console, `unity_test` runs the tests. Tests are refused while
the scene has unsaved changes: Unity would raise a "save scene?" dialog that freezes the Editor.

| Editor state | `unity_compile` | `unity_test` | scenes, Console |
|---|---|---|---|
| open, Pipeline installed | Unity recompile | runs in the Editor | available |
| open, no Pipeline | `dotnet build` | refused, with instructions | not available |
| closed | `dotnet build`, or batch mode when no `.csproj` exist | `unity test` (Unity CLI) or `-batchmode -runTests` | not available |

The Pipeline package is experimental, so its command names may change. Everything that depends
on them lives in `src/scene.ts`, `src/unity/pipeline.ts` and `src/unity/tests.ts`. Developed
against `com.unity.pipeline` 0.7.0-exp.1.

## Options

All optional. Sources, later wins: `~/.config/opencode/opencode-unity/config.json`,
`<project>/.opencode/unity.json`, options passed in `opencode.json`
(`"plugin": [["opencode-unity", { ... }]]`).

```jsonc
{
  "compileOnEdit": true,
  "compileBackend": "auto",        // auto | dotnet | editor
  "lint": true,
  "idleGate": true,
  "idleGateRetries": 2,
  "rules": true,
  "agent": true,
  "sceneTools": "simple",          // simple = one flat tool per action (small models)
                                   // batch = unity_scene_edit with a list of operations | both
  "docs": "manual",                // auto = download missing docs in the background
  "allow": [],                     // guard rules to switch off: meta, generated, project-files,
                                   // serialized-asset, project-settings, package-manifest
  "executeMethods": [],            // e.g. ["MyGame.Editor.Builder.Build"]
  "editorPath": null,
  "maxErrors": 8,
  "compileTimeoutMs": 120000
}
```

## Where things live

| What | Where |
|---|---|
| Symbol graph, one per Unity version | user cache: `~/Library/Caches/opencode-unity`, `%LOCALAPPDATA%\opencode-unity`, `$XDG_CACHE_HOME/opencode-unity` |
| Documentation index, one per release stream | same, under `docs/` |
| Package symbols, package docs, MSBuild targets | `<project>/Library/OpencodeUnity/` |
| Build output | `<project>/Temp/` (Unity's own intermediate folder) |

Documentation indexes are always built on the user's machine from Unity's official archive; none
is redistributed.

## Platforms

Written for macOS, Windows and Linux (path handling, process-tree kill, Editor discovery, lock
detection). Exercised on macOS only so far.

## Layout

```
packages/opencode-unity/   the plugin (TypeScript; runs on Bun in the opencode CLI and on Node in opencode desktop)
tools/symbol-exporter/     .NET tool (Mono.Cecil) that dumps the API of a set of DLLs
```

## Development

```sh
cd packages/opencode-unity
bun test
bun run typecheck
```

To run from source instead of the bundle, create `.opencode/plugins/unity.ts` in a Unity project:

```ts
export { UnityPlugin } from "/absolute/path/to/packages/opencode-unity/src/index.ts"
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Where the project stands, what is verified and what is not:
[docs/STATUS.md](docs/STATUS.md). What was learned about building tools for small models:
[docs/small-model-tool-design.md](docs/small-model-tool-design.md).

## License

[MIT](LICENSE). Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Not affiliated with, sponsored by, or endorsed by Unity Technologies. "Unity" is a trademark of
Unity Technologies.

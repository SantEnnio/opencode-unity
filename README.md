# opencode-unity

Guardrails for small/local models working on Unity projects in [opencode](https://opencode.ai).

Small models plan well but write Unity code from memory: APIs that never existed, APIs that were
renamed in Unity 6, missing `using` directives. They also do not go and check. This plugin does
the checking for them, deterministically, and puts the answer where they cannot miss it: in the
result of the edit they just made.

## Install

Works with opencode 1 and opencode 2, CLI and desktop (checked on 1.18.31 and 2.0.20).

Requirements: the .NET SDK (6.0 or newer) on `PATH`, and the project's Unity Editor version
installed through Unity Hub (or `UNITY_EDITOR_PATH` pointing at it).

The plugin is not on npm yet.

**Windows, from a release** (no Bun, git or administrator rights needed). In PowerShell:

```powershell
irm https://github.com/SantEnnio/opencode-unity/releases/latest/download/install.ps1 | iex
```

Run it again to update. For a classroom, download `install.ps1` and the `opencode-unity-*.tgz`
of a [release](https://github.com/SantEnnio/opencode-unity/releases) once, put them on a shared
drive, and on each machine run
`powershell -ExecutionPolicy Bypass -File install.ps1 -Package opencode-unity-0.4.0.tgz`.
`-Uninstall` removes the plugin.

**From a clone of this repository** (any OS, needs [Bun](https://bun.sh)):

```sh
cd packages/opencode-unity
bun install
bun run install:global      # bun run uninstall:global to remove
```

Both put the plugin in `~/.config/opencode/plugins/opencode-unity.js` (on Windows
`%USERPROFILE%\.config\opencode\...`), with its assets in `~/.config/opencode/opencode-unity/`.
Both opencode generations load plugins from that folder:
restart opencode (opencode 2 also reloads it on its own when the file changes).

The plugin activates when the opened folder is, contains, or sits inside a Unity project, and
does nothing anywhere else.

**Is it on?** Open a Unity project and type `/unity`: the plugin reports that it is active, what
it found (Unity version, Editor install, .NET SDK, docs, Unity CLI) and which route compile, tests
and console will take. The `unity-coder` agent also appears in the agent list, only in Unity
projects. At startup it writes one line (`opencode-unity x.y.z active: ...`) to the opencode log
in opencode 1, and to its own log in opencode 2, which gives plugins no log: `opencode-unity.log`
in the user cache folder (`~/Library/Caches/opencode-unity`, `%LOCALAPPDATA%\opencode-unity`,
`$XDG_CACHE_HOME/opencode-unity`).

**opencode 1 and 2 on the same machine.** They share `~/.local/share/opencode`, and opencode 2
migrates the session database there: after that, opencode 1 stops with `no such column:
project_id`. Pick one per machine, or point opencode 1 at another data folder (`XDG_DATA_HOME`).

**Documentation.** The plugin searches the Unity Manual and Scripting Reference offline, but does
not download them: it uses the **Documentation module** of the Editor, which Unity Hub installs
next to it (Installs, the menu of your Unity version, Add modules, Documentation). With the module
installed, the plugin indexes it in the background the first time, in about 10-15 s, and keeps the
index in its cache. Without it, `/unity` and the documentation tools say how to add it; API lookups
(`unity_lookup`) work either way, since they read the Editor's own assemblies.

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

- Obsolete API that Unity would rename itself (`[Obsolete("... (UnityUpgradable) -> linearVelocity")]`)
  is spotted in the same build, and the report ends with `→ Next: call unity_update_api`. That
  tool makes the renames, at the compiler's positions, in the scripts the agent wrote, and shows
  each line as it is now, so the agent's next edit matches the file. Unity then finds nothing to
  update and does not stop on its API Updater dialog. If the agent stops first, the idle gate sends
  it back once. Renames into another namespace or assembly stay a hint, as do APIs Unity does not
  mark as upgradable (`FindObjectOfType`).
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
| `unity_docs_search` / `unity_docs_read` | Manual + Scripting Reference from the Editor's Documentation module, and the docs of the installed packages, offline (SQLite FTS5) |
| `unity_scene_view`, `unity_object_*`, `unity_component_*`, `unity_prefab_*`, `unity_scene_save` | Read and change the open scene through the Editor: objects, components, values, references, prefabs. One flat tool per action, validated before anything is touched (see below) |
| `unity_pipeline_install` | Adds the Pipeline package to the project, only after the user has agreed |
| `unity_compile` | Explicit check. Uses Unity's own compiler when it can (see below) |
| `unity_update_api` | Makes Unity's own renames of obsolete API (`rb.velocity` → `rb.linearVelocity`) in the scripts the agent wrote, so Unity does not stop on its API Updater dialog; shows every changed line |
| `unity_test` | EditMode/PlayMode tests, failures only |
| `unity_console` | Console of the open Editor (runtime errors, stack traces) |
| `unity_probe_install` | Adds the optional runtime probe to the project, after the user agrees (only while it is missing or out of date) |
| `unity_play` | What happened in the last Play: errors, how objects moved, collisions, input. With a path, one object's timeline. With `new_run: true`, runs the game itself for 5 s first; with `keys` (`"W 2s; Space"`), presses those keys during that run (only once the probe is installed) |
| `unity_run_method` | `-executeMethod` for a whitelist of methods (only registered when `executeMethods` is set) |

**Context**: a ~12 line rules block with the project's facts (Unity version, render pipeline,
input handling, notable packages) is added to the system prompt, and a `unity-coder` agent
(low temperature, edit → read report → fix loop) is registered.

## The open Editor: scenes, Console, tests

A model that cannot touch the scene ends up writing throwaway Editor scripts that build it, or,
worse, editing the `.unity` YAML by hand. The plugin blocks the YAML and gives it a real tool
instead, by talking to the Editor you already have open.

This needs Unity's **Pipeline package** (`com.unity.pipeline`, experimental) in the project. Just
ask the agent ("install the Pipeline package"): it calls `unity_pipeline_install`, and only after
you agree does the tool run `unity pipeline install` for the project (it needs the official Unity
CLI). Or run that command yourself in the project folder.

The package is never installed without your approval: it changes `Packages/manifest.json`. In
opencode 1 the approval is opencode's permission prompt. opencode 2 has no prompt a plugin can
raise, so the first call only tells the model to ask you, and a second call installs only if you
have replied in between. If the
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

## Watching the game: the runtime probe

The Console only shows what the code chose to print. It cannot say that the player *never moved*,
where the car was at 3 s, what it hit, or whether the Jump action fired at all. The optional
**runtime probe** can: a small Unity package that records each Play in the Editor.

Install it by asking the agent (it calls `unity_probe_install` and you approve), or with
`bunx opencode-unity probe install <project>`. It is copied into `Packages/com.opencode-unity.probe/`
(no git needed), runs in the Editor only (nothing goes into builds), adds nothing to your scenes,
and is removed by deleting that folder. `/unity` shows whether it is installed and up to date.

While you play, it records errors (collapsed), the objects the agent created or changed plus
anything with a Rigidbody or CharacterController, collisions, keys and Input System actions, and
pauses. On Stop it writes `Library/OpencodeUnity/probe/last-run.json`, and the plugin reduces it to
a few lines:

```
[unity] Recorded by the runtime probe while the user played. Last play 1.0 s, 633 frames: 2 problems.
- NullReferenceException in Thrower.Update () (Assets/Scripts/Thrower.cs:9), 1×, first at 1.0 s: Object reference not set to an instance of an object
- The game was paused at 1.0 s for 1.2 s: Unity pauses on the first error when Error Pause is on in the Console
→ unity_console shows the stack traces; unity_play path "/Faller" shows its timeline.
```

That note goes with your next message, so the model knows what just happened without calling
anything. The context is small, so the note is added to the request only, never stored in the
session; it goes at the end, where it does not break a local server's prompt cache; it is dropped
after two messages or at the next Play; and a Play with nothing unusual is one line. More detail,
also fixed in size, comes from `unity_play`.

The agent can also run the game itself: `unity_play` with `new_run: true` plays for 5 seconds with
nobody pressing keys and returns the report. That checks start-up, gravity, spawning and errors,
not the controls. For the controls, `keys` presses keys during the run, for example
`keys: "W 2s; Space; W+D 1s; wait 1s"`, and the report then shows whether the player moved and
which Input Actions fired. The keys go through a virtual keyboard the probe adds for the run,
which both Input Actions and scripts reading `Keyboard.current` see; the project must use the
Input System package (the old Input Manager cannot be driven). The probe starts and stops Play from inside Unity, so this
works without the Pipeline package, and while Unity is in the background: for the test only, it
sets Unity's Interaction Mode to No Throttling and puts your setting back afterwards. It refuses
while you are playing, and while the project does not compile. The design and its measurements are in
[docs/runtime-module.md](docs/runtime-module.md).

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
| Documentation index, one per Editor version | same, under `docs/` |
| Package symbols, package docs, MSBuild targets | `<project>/Library/OpencodeUnity/` |
| Build output | `<project>/Temp/` (Unity's own intermediate folder) |

Documentation indexes are always built on the user's machine from the documentation Unity Hub
installed with the Editor; none is redistributed.

## Platforms

Written for macOS, Windows and Linux (path handling, process-tree kill, Editor discovery, lock
detection). Exercised on macOS only so far.

## Layout

```
packages/opencode-unity/   the plugin (TypeScript; one bundle for opencode 1 and 2, on Bun and on Node)
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
[docs/small-model-tool-design.md](docs/small-model-tool-design.md), with the measurements behind it in
[docs/qwen3.6-test-report.md](docs/qwen3.6-test-report.md).

## License

[MIT](LICENSE). Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Not affiliated with, sponsored by, or endorsed by Unity Technologies. "Unity" is a trademark of
Unity Technologies.

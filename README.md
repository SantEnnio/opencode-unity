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
  `Packages/manifest.json` and generated project files are blocked, with what to do instead.
- Idle gate: if the model stops while the build is red, it is sent back to fix the errors
  (twice at most per user message).

**Tools**

| Tool | Purpose |
|---|---|
| `unity_status` (`/unity`) | Is the plugin active, what did it find, which routes are available |
| `unity_lookup` | Fuzzy API lookup: signatures, overloads, obsolete → replacement, example from the docs |
| `unity_docs_search` / `unity_docs_read` | Offline Manual + Scripting Reference + docs of the installed packages (SQLite FTS5) |
| `unity_docs_install` | Background download + indexing of the offline documentation |
| `unity_compile` | Explicit check. Uses Unity's own compiler when it can (see below) |
| `unity_test` | EditMode/PlayMode tests, failures only |
| `unity_console` | Console of the open Editor (runtime errors, stack traces) |
| `unity_run_method` | `-executeMethod` for a whitelist of methods (only registered when `executeMethods` is set) |

**Context**: a ~12 line rules block with the project's facts (Unity version, render pipeline,
input handling, notable packages) is added to the system prompt, and a `unity-coder` agent
(low temperature, edit → read report → fix loop) is registered.

## Unity CLI and the open Editor

With the official Unity CLI (`unity`) installed and the **Pipeline package**
in the project (`unity pipeline install`), the plugin talks to the open Editor:
`unity_compile` triggers a real recompile and reads Unity's verdict, `unity_test` runs in the
Editor, `unity_console` reads its Console. Without it:

| Editor state | `unity_compile` | `unity_test` |
|---|---|---|
| open, Pipeline installed | Unity recompile | runs in the Editor |
| open, no Pipeline | `dotnet build` | refused, with instructions |
| closed | `dotnet build`, or batch mode when no `.csproj` exist | `unity test` (Unity CLI) or `-batchmode -runTests` |

The plugin never installs the Pipeline package by itself: that changes the project's manifest.

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

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Not affiliated with, sponsored by, or endorsed by Unity Technologies. "Unity" is a trademark of
Unity Technologies.

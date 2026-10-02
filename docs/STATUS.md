# Project status

Last updated: 2026-10-01. Version 0.3.0. Source on GitHub
([SantEnnio/opencode-unity](https://github.com/SantEnnio/opencode-unity)), no npm release yet.

The second plugin of this repository, `opencode-game-prototype` (three.js prototypes checked in a
real browser), has its own page: [STATUS-game-prototype.md](STATUS-game-prototype.md).

## What exists

| Area | State |
|---|---|
| Compile on every `.cs` edit (`dotnet build` on Unity's generated projects, new/deleted scripts reconciled) | Done, verified on a real project and with a real small model in opencode |
| Symbol graph from the Editor's DLLs + project packages, error enrichment (CS1061, CS0117, CS0246, CS0103, CS0618/9, CS1501, CS1503, CS7036, CS0122) | Done, verified on real model mistakes |
| `unity_lookup` (fuzzy API lookup, examples from the docs) | Done, verified with a real model |
| Offline docs: download, ZIP64 reader, HTML to text, SQLite FTS5, package docs | Done. Unity 6000.0: 34,331 pages, 61 MB index, about 20 s to install |
| Unity-specific lints | Done, unit-tested. Regex based: expect some false positives/negatives on unusual formatting |
| Guards on protected files | Done, verified |
| Idle gate (re-prompt when the model stops on a red build) | Done. Verified live in opencode 2.0.20: the model stopped on a red build, got the message twice, and went back to work. In opencode 1 only tested with a fake client |
| Rules block in the system prompt | Done. Confirmed to reach the model in opencode 2.0.20. In opencode 1 it relies on a hook marked experimental and is not confirmed |
| `unity-coder` agent, `/unity` command, `unity_status` | Done. Agent and command registration verified in opencode |
| Open Editor through Unity's Pipeline package: recompile, Console, tests | Done, verified live. Direct HTTP client, about 50 ms per call |
| `unity_pipeline_install` only after the user agrees | Done. opencode 1: its permission prompt, verified in desktop. opencode 2 has none a plugin can raise: the first call has the model ask, the second installs only if the user replied in between. Verified in 2.0.20 |
| Scene editing, flat tools (`unity_object_*`, `unity_component_*`, `unity_prefab_*`, `unity_scene_save`) | Done, verified live and **driven by a small model**: a 168-call session built a car (2026-09-20). Four failures found there are fixed, covered by tests, and the rename/re-parent one re-checked against qwen3.6-35b-a3b: the same task went from 10 calls with 3 rejections to 5 with none. See `small-model-tool-design.md` |
| Scene editing, batch tool (`unity_scene_edit`) | Done, opt-in (`sceneTools: "batch"`). Small models cannot drive it reliably |
| Closed-Editor routes: batch-mode compile, `unity test` / `-runTests` | Done, verified live |
| Runtime probe, step 1 (optional Unity package, `unity_probe_install`, `unity_play` reading the last Play, play note on the next message) | Done 2026-09-30, verified live in Unity 6000.0.71f1 and opencode 2.0.20: falls, collisions, an exception and the Error Pause it caused were recorded and reduced; the note reached the model and was not stored in the session. Not yet seen with a small model, nor on Windows. See `runtime-module.md` |
| Runtime probe with qwen3.6-35b-a3b (2026-09-30, night) | Three plain-language tasks in the sandbox, each done alone: check that W moves and Space jumps (2 min, keys chosen by the model), fix a jump bound to J (78 s, fixed and verified with a key test), fix a ball hanging in the air (88 s, missing Rigidbody, verified with a test play). Each session was read back; the fixes it prompted are in `runtime-module.md` |
| Runtime probe, step 3 (`unity_play` with `keys`: key presses on a virtual Input System keyboard) | Done 2026-09-30, verified live: `W 2s; Space` moved a cube driven by Input Actions (7.3 m, jumped to y 1.7) and one reading `Keyboard.current` (5.8 m), with Unity in the background. Input settings are swapped for a temporary copy during the run, never saved. Only the keyboard, no mouse or gamepad |
| Runtime probe, step 2 (`unity_play` with `new_run`: a 5 s test play with no input) | Done 2026-09-30, verified live without the Pipeline package: the probe started and stopped Play from the request file, the run was marked as the agent's, Interaction Mode was restored. ~8-9 s per call. **Not tried live**: the refusal while the user is playing, and the route through the Pipeline package's `editor_play` |
| `unity_run_method` (whitelisted `-executeMethod`) | Written, **never run** |
| opencode 2 | Done (2026-09-30), one bundle for both: `src/host-v1.ts` and `src/host-v2.ts` over `src/core.ts`. Verified live in 2.0.20 (CLI inside the desktop app): loading, `unity_status`, compile on edit, guards, idle gate, rules, `/unity`, `unity-coder`, consent, flat scene tools with the open Editor. Same bundle re-checked in opencode 1.18.31 |
| Runs on Bun (opencode 1 CLI, opencode 2) and Node (opencode 1 desktop, Electron) | Done. Verified inside both desktops' runtimes; the smoke test loads the bundle under both plugin APIs on Node and on Bun, in CI too |
| Windows installer from a GitHub release (`install.ps1`: no Bun, git or admin rights) | Done. CI installs the release package with Windows PowerShell 5.1 and PowerShell 7, loads it and uninstalls. **Not yet run on a classroom machine** |
| Global installer, npm packaging (`dist/` bundle + prebuilt exporter) | Done. `npm pack --dry-run` checked; **installing from npm untested** (nothing published) |

107 unit tests, typecheck clean, smoke test passing on Node and Bun.

## Not verified

- **Windows and Linux.** The code is written for them (paths, process-tree kill, Editor discovery,
  lock detection, cache locations). The unit tests, the typecheck and the Node smoke test pass in CI
  on Windows and Linux (2026-09-30); the first Windows run found an SQLite file left open, now
  fixed. Nothing has run there against a real Unity Editor.
- The idle gate and the rules block in a real opencode 1 session (see the table).
- `com.unity.pipeline` 0.8.0-exp.1: `unity pipeline install` now installs it, and everything was
  developed against 0.7.0-exp.1. The opencode 2 checks above ran against 0.7.0-exp.1.
- Two Editors open at once: both claim the Pipeline port 7800 and the second stays unreachable
  (seen 2026-09-30). Detected since then: the other Editor answers 401, and the plugin says "two
  Unity projects are open at once" in `/unity` and in every tool that needs the Editor, instead of
  a generic "not connected" (qwen had retried four times on the raw "Unauthorized").
- PlayMode tests, `unity_run_method`.
- Scene tools not exercised live: array properties other than materials. (`unity_component_remove`
  and re-parenting/renaming through `unity_object_modify` were exercised in the 2026-09-20
  session.)
- Large projects: only projects with a handful of scripts were used. Unknown: `dotnet build` time
  with many assemblies, cost of scanning `Assets/` for new scripts on every edit.
- Installing with `"plugin": ["opencode-unity"]` from npm.

## Known issues and limits

- **Context size.** 19 tools are registered in a Unity project (about 2,500 tokens). With a small
  model, long sessions degrade visibly: prefer new sessions and small tasks.
- **Unity Console noise.** When Unity rejects a command, the Pipeline package logs an error in the
  user's Console. The plugin validates as much as it can beforehand and stops repeating failed
  calls, but a rejection it could not predict still leaves one line. It cannot be cleared
  selectively.
- **Pipeline package pitfalls** (developed against `com.unity.pipeline` 0.7.0-exp.1, experimental):
  synchronous `run_tests` deadlocks the Editor, so tests always run async with polling; running
  tests while the open scene has unsaved changes freezes the Editor on a "save scene?" dialog, so
  the plugin refuses; command names may change between versions. Everything that depends on the
  package lives in `src/scene.ts`, `src/unity/pipeline.ts`, `src/unity/tests.ts`.
  Version check 2026-09-21: `0.7.0-exp.1` (published 2026-06-25) is still `latest` on
  packages.unity.com and the docs are still at `@0.7`, so the command names above hold. Unity's
  own docs describe only `eval`/`eval_file` and ship no MCP server or agent-facing layer.
- No headless scene editing: with the Editor closed the scene tools explain what the user has to
  do. (`unity run --command` could provide it, at the cost of an Editor start per call.)
- **Play mode is throttled to a standstill unless the Editor has focus — unless Interaction Mode
  is NoThrottling** (measured 2026-09-20 on the probe, macOS, 6000.0.71f1). Unfocused and with the
  default preference, a falling Rigidbody stayed frozen for 2.8 s; it ran only while `editor_focus`
  held the foreground. `set_autotick` ticks the Editor, not the game loop, and
  `PlayerSettings.runInBackground` (set through `eval`, read back true) is a build setting that
  changes nothing here. The switch is the **global EditorPrefs int `"InteractionMode"`**
  (`UnityEditor.PreferencesProvider+InteractionMode`: `0 Default, 1 NoThrottling, 2
  MonitorRefreshRate, 3 Custom`). Setting it to 1 through `eval` takes effect immediately, with no
  apply call: the same cube then fell 12 → 0.5 unfocused, in 1.6 s against 1.53 s of theoretical
  free fall, so the simulation runs at correct real time and what is sampled is physically
  meaningful. Two conditions on using it: it is a **user preference global to the Unity install,
  not to the project**, so it must be restored after the run and the user should be asked first;
  and NoThrottling pegs a core. **Anything that observes a running game must still prove time
  advanced** (compare `Time.frameCount` across samples) before reporting what it saw: a report
  that says "the object never moved" when the game was merely throttled sends a small model to fix
  a bug that is not there. Other play-mode facts from the same run: `editor_play`/`editor_stop`/`editor_status`
  work and report `playMode`; the first call after `editor_play` costs ~6.6 s (domain reload
  drops the HTTP listener — `pipelineExec`'s retry already covers it); reads answer in ~65 ms
  and batch 3 objects in ~190 ms; scene-mutating commands are refused with "This cannot be used
  during play mode"; `get_component_properties` returns serialized fields only, so a Rigidbody
  has no runtime velocity (derive it from position deltas); `wait_for` never tracked a live
  object through `target` + dotted member, and bound to an arbitrary instance through `findType`.
- `dotnet build` is an approximation of Unity's compiler (no source generators on old SDKs, asmdef
  edge cases). `unity_compile` asks Unity itself when the open Editor is reachable.
- Guards cover the file-writing tools only. A model that deletes or moves a script through the
  shell leaves an orphan `.meta` — **observed**, not hypothetical: in the 2026-09-20 session the
  model gave up on a script and removed it with `bash rm`. This is what next step 5 is about.
- Documentation search ranks Scripting Reference pages above Manual pages even for conceptual
  questions.
- Materials created through `color` are one per object, named after it, under `Assets/Materials/`.
- **Tags and layers: listing is wired, creating is not.** The whole-scene `unity_scene_view` lists
  the project's tags and layers, so the model picks one that exists instead of learning by
  rejection (verified with qwen3.6-35b-a3b: it answered the question and tagged the object in two
  calls). The per-object view deliberately omits them — a real session called it 28 times against
  4 whole-scene views, and three lines each is context the task needs. Creating one is *possible* — the Pipeline package has `set_tags_layers`, verified
  live on 2026-09-20: `{"settings":{"addTags":["Enemy"]},"confirm":true}` added the tag. No tool
  exposes it yet, so today the model still has to ask the user. Two traps for whoever wraps it:
  the key that names a user layer (index 8-31) is not `layers`/`layerNames`/`setLayers` and is
  still unknown, and the command answers `success: true, applied: false` for settings it did not
  understand — the wrapper must diff `values` against what it asked for, never trust `success`.

## Next steps

1. Watch a small model use the flat scene tools in a real session and fix what it trips on. Every
   fix so far came from reading real sessions (see `small-model-tool-design.md`).
2. Confirm the idle gate and the rules block in a real opencode 1 session.
3. Run `install.ps1` on a classroom machine with opencode 2, then a full session there.
4. Check the plugin against `com.unity.pipeline` 0.8.0-exp.1, and detect two Editors fighting
   over the Pipeline port.
5. npm: publishing is off (repository variable `NPM_PUBLISH`). To turn it on, use a token that
   can bypass 2FA, or trusted publishing after a first manual publish.
6. Reduce the tool count for small models (for example hide `unity_docs_install` once the docs are
   installed, and the scene tools when no Editor is connected).
7. Shell guard for `rm`/`mv` on assets; more lints (`Destroy` in loops, `CompareTag`).
8. Better ranking between Manual and Scripting Reference in `unity_docs_search`.
9. Runtime module: let the model learn what the game does while it plays. Designed and measured,
   not built — see [runtime-module.md](runtime-module.md).

## Decisions worth remembering

- **Push, not pull.** A small model does not go and look things up, so the lookup is done for it
  and attached to the error it has to fix. Tools it must choose to call are secondary.
- **Hooks over prompts.** Anything that can be enforced in a hook is enforced there. The always-on
  rules are about a dozen lines.
- **Unity's own pieces where they exist.** The Pipeline package instead of a custom Editor bridge;
  its HTTP API directly instead of one CLI process per call.
- **Nothing owned by Unity is redistributed.** API and documentation indexes are built on the
  user's machine from their own Editor installation and Unity's official documentation archive.
- **The project is never changed without consent**: the Pipeline package is installed only after
  opencode's permission prompt, scenes are not saved unless asked, asset writes are announced.

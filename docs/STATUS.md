# Project status

Last updated: 2026-09-20. Version 0.1.0, not published yet (no GitHub repository, no npm release).

## What exists

| Area | State |
|---|---|
| Compile on every `.cs` edit (`dotnet build` on Unity's generated projects, new/deleted scripts reconciled) | Done, verified on a real project and with a real small model in opencode |
| Symbol graph from the Editor's DLLs + project packages, error enrichment (CS1061, CS0117, CS0246, CS0103, CS0618/9, CS1501, CS1503, CS7036, CS0122) | Done, verified on real model mistakes |
| `unity_lookup` (fuzzy API lookup, examples from the docs) | Done, verified with a real model |
| Offline docs: download, ZIP64 reader, HTML to text, SQLite FTS5, package docs | Done. Unity 6000.0: 34,331 pages, 61 MB index, about 20 s to install |
| Unity-specific lints | Done, unit-tested. Regex based: expect some false positives/negatives on unusual formatting |
| Guards on protected files | Done, verified |
| Idle gate (re-prompt when the model stops on a red build) | Done, **only tested with a fake client** |
| Rules block in the system prompt | Done, **relies on an opencode hook marked experimental; not confirmed to reach the model** |
| `unity-coder` agent, `/unity` command, `unity_status` | Done. Agent and command registration verified in opencode |
| Open Editor through Unity's Pipeline package: recompile, Console, tests | Done, verified live. Direct HTTP client, about 50 ms per call |
| `unity_pipeline_install` behind opencode's permission prompt | Done, verified in opencode desktop |
| Scene editing, flat tools (`unity_object_*`, `unity_component_*`, `unity_prefab_*`, `unity_scene_save`) | Done, verified live with a scripted run. **Not yet seen driven by a small model** |
| Scene editing, batch tool (`unity_scene_edit`) | Done, opt-in (`sceneTools: "batch"`). Small models cannot drive it reliably |
| Closed-Editor routes: batch-mode compile, `unity test` / `-runTests` | Done, verified live |
| `unity_run_method` (whitelisted `-executeMethod`) | Written, **never run** |
| Runs on Bun (opencode CLI) and Node (opencode desktop, Electron) | Done. Verified inside opencode desktop's own runtime; CI has a Node smoke test |
| Global installer, npm packaging (`dist/` bundle + prebuilt exporter) | Done. `npm pack --dry-run` checked; **installing from npm untested** (nothing published) |

98 unit tests, typecheck clean, Node smoke test passing.

## Not verified

- **Windows and Linux.** The code is written for them (paths, process-tree kill, Editor discovery,
  lock detection, cache locations) and unit tests cover the Windows path logic, but nothing has
  run there. CI will be the first run once the repository is public.
- The idle gate and the rules block in a real opencode session (see the table).
- PlayMode tests, `unity_run_method`.
- Scene tools not exercised live: `unity_component_remove`, re-parenting and renaming through
  `unity_object_modify`, array properties other than materials.
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
- No headless scene editing: with the Editor closed the scene tools explain what the user has to
  do. (`unity run --command` could provide it, at the cost of an Editor start per call.)
- `dotnet build` is an approximation of Unity's compiler (no source generators on old SDKs, asmdef
  edge cases). `unity_compile` asks Unity itself when the open Editor is reachable.
- Guards cover the file-writing tools only. A model that deletes or moves a script through the
  shell leaves an orphan `.meta`.
- Documentation search ranks Scripting Reference pages above Manual pages even for conceptual
  questions.
- Materials created through `color` are one per object, named after it, under `Assets/Materials/`.

## Next steps

1. Watch a small model use the flat scene tools in a real session and fix what it trips on. Every
   fix so far came from reading real sessions (see `small-model-tool-design.md`).
2. Confirm the idle gate and the rules block in a real session.
3. Publish: GitHub repository (CI gives the first Windows/Linux run), then npm. Open points:
   repository URL for `package.json`, copyright holder line in `LICENSE`.
4. Reduce the tool count for small models (for example hide `unity_docs_install` once the docs are
   installed, and the scene tools when no Editor is connected).
5. Shell guard for `rm`/`mv` on assets; more lints (`Destroy` in loops, `CompareTag`).
6. Better ranking between Manual and Scripting Reference in `unity_docs_search`.

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

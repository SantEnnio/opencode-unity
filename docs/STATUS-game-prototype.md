# opencode-game-prototype: status

Last updated: 2026-10-04. Version 0.2.0 (release `game-prototype-v0.2.0`; 0.1.0 shipped with the
repository's v0.4.0, before the plan-and-phases flow). The
second plugin of this repository (`packages/opencode-game-prototype`): quick three.js game
prototypes with a small model, checked in a real browser. [STATUS.md](STATUS.md) is about
`opencode-unity`.

## What exists

| Area | State |
|---|---|
| `proto_new`: a prototype that already runs (page, starter game, fixed `vendor/` with three.js r186 and the kit) and its `PLAN.md` | Done, verified live. In a Unity or Unreal project it goes in `.prototypes/<name>/`, elsewhere in the folder opencode runs in |
| **Plan first** (2026-10-03): `PLAN.md` with the idea and phases, each with a `Test` line (keys) and `Expect` lines in a dozen English forms; the code is locked until the plan is written (`planFirst`); every save of the plan answers with what is missing, and the forms section is put back when a rewrite drops it | Done, verified live and with qwen (below). The parser takes the plan as a model writes it: prose instead of an Idea heading, bold keys, bullets under a bare `Expect:` |
| **`proto_test`** (2026-10-03): runs each phase's keys in the browser, checks every `Expect` line, answers PASSED/FAILED with what was seen instead, writes `Status: passed/failed` next to the phase; the idle gate nudges on a failing phase | Done, verified live and with qwen. Forms: moves (also a direction, back and forth, not at all), jumps N times, rises, falls, is reset, is removed, appears, turns a colour, x/y/z comparisons, ends at (x, y, z), is above/on another object, text contains/is, on/off screen, no errors. Repeated lines and a phase that expects nothing new are flagged |
| **`proto_lookup`** (2026-10-03): fields and methods of any three.js class, from the shipped build (constructed when possible, read from the source otherwise) | Done, unit-tested. Not yet seen used by a model |
| Kit misuse found by reading (`keys.isDown`, `game.update`, an import the kit does not have) | Done, unit-tested |
| **Journal and `SESSION.md`** (2026-10-03): every plan save, blocked write, page check, test play, phase test and lookup is appended to `.proto/journal.jsonl` in the prototype; `proto_export` / `/prototype-export` write `SESSION.md` (plan as it stands, numbers, timeline, phase tests in full); `proto_test` keeps it current. The folder is what a student hands in | Done, verified live and in the browser test. The model's prose and the user's requests are not in it: hooks do not see them |
| **Kit grown** (2026-10-03): `game.box`/`game.sphere` (named, in the scene), `onTop(a, b)`, `landOn(a, b)`, `follow(camera, target, dx, dy, dz)`; the starter game uses them and the camera follows the player | Done, browser tests pass on the new starter game. **Not shown to help yet**: two platform sessions with the kit ran 86 and 120 minutes without finishing (the model kept trying to land a jump on a moving platform with a fixed key script, a timing problem), against 39 minutes for the run before the kit. Two runs, high variance: inconclusive |
| Release of this package alone: tag `game-prototype-vX.Y.Z`, never marked latest; the installer finds the newest release carrying its package | Written in `release.yml` and `install-game-prototype.ps1`; first used for game-prototype-v0.2.0 (2026-10-04) |
| Test play report (2026-10-03): a timeline per object (when it moved, fell, stopped, was reset), colour changes, objects grouped by name, the time the text on screen changed | Done, verified on qwen's own prototypes |
| Local server (`node:http`, 127.0.0.1, port 4317 or a free one), serving prototypes only, probe added to the page | Done, verified on Bun and on Node 24 |
| Test browser: Edge or Chrome with no window, one process per run, nothing installed | Done, verified on macOS with Chrome 154 and Edge 154. About 2 s for a page check, 3 to 5 s for a test play. No browser process was left behind after the sessions below |
| Page check on every edit of a prototype file, appended to the edit's result | Done, verified live and with qwen3.6-35b-a3b |
| What the check catches | Verified live: a removed three.js class, a syntax error, a missing import, an error inside the game loop (with the freeze it causes), a camera that looks at nothing (flat screen), a deprecated class (as a warning) |
| `FIX:` lines | Done for: a three.js name that does not exist (the real exports of the shipped build, with the renamed or closest name), a module that cannot be imported, `require`, a missing file. Names are also checked by reading the scripts, so a wrong name on a line that did not run is still reported |
| `proto_play`: test play with key presses (`"D 1s; Space"`, same words as `unity_play`) | Done, verified live and with qwen. Reports what moved and how far, jumps counted, objects that appeared or were removed (grouped by name), the text on screen and when it changed, a flat screen |
| The user's own tab: reload on every edit, test play in the tab when no windowless browser can run, errors seen while the user plays go with their next two messages | Done. Verified with a second windowless browser standing in for the tab. **Not tried in a visible browser tab with a person playing** |
| `game-prototyper` agent, rules block, `/prototype`, guard on `vendor/`, idle gate | Done. Agent, tools and the report on edit verified in opencode 2.0.22 with qwen. The idle gate was switched off in those runs (`--auto`), so it is only unit-tested |
| One bundle for opencode 1 and 2, on Node and on Bun | Smoke test passes on both. **Never loaded in a real opencode 1** |
| Windows, Linux and macOS in CI (2026-10-02) | The whole path runs in a real browser on the three runners: a test play that reaches the coin, a broken edit caught with its `FIX:` line, the fix passing. Windows used Edge (`msedge.exe`), about 25 frames a second drawn in software. Linux needs one setting on the runner, see below |
| Windows installer (`install-game-prototype.ps1`: no Bun, git or admin rights) | Done. CI installs the release package with Windows PowerShell 5.1 and PowerShell 7, plays a prototype through the installed copy in Edge, and uninstalls. **Not yet run on a classroom machine** |
| Release: the package and its installer attached to the repository's release | Done. v0.4.0 (2026-10-02) carries `opencode-game-prototype-0.1.0.tgz` and `install-game-prototype.ps1` next to the `opencode-unity` ones, and is the latest release. The one-line install that downloads from it was **not run**: CI installs from a local package |

45 unit tests (three of them drive a real browser), typecheck clean, smoke test passing on Node and
Bun.

## Sessions with qwen3.6-35b-a3b (2026-10-02, opencode 2.0.22)

Each was one plain-language request in Italian, read back from opencode's database afterwards.

| Request | Calls | What happened | What it changed |
|---|---|---|---|
| A double jump, not a triple one | 4, none rejected, 2.5 min | `proto_new`, read, one edit, one test with `"Space; wait 0.3s; Space; wait 0.1s; Space"`. The code was right | It reported "the third press does nothing" from a single height, which does not show it. Test plays now count sudden gains of upward speed: `pushed upward 2 times (at 0.0 s, 0.5 s)` |
| Red enemies fall, touching one is game over and the game stops | 8, none rejected, 2.3 min | Wrote the whole game in one `write`, then four test plays, standing still until an enemy hit. It wrote "the game freezes" while enemies kept spawning after GAME OVER | Seven "Enemy appeared" lines became one (`12 objects named Enemy appeared, the first at 0.6 s …, the last at 9.4 s`), and the text on screen says when it changed (`"" → "GAME OVER" (at 4.1 s)`): the two together show a game that did not stop. A player that went right and came back is no longer `moved 10.1: (0.0, …) → (0.1, …)` |
| A dash on Shift, in a folder that is a Unity project (both plugins active, 22 tools) | 6, one rejected, 2.7 min | The prototype went to `.prototypes/dash`. One `write`, three test plays. It wrote the keys as `"W A 0.5s"`, got the form back with the example, and sent `"W+A 0.5s"` next. It called no `unity_*` tool | Nothing. Still open: `opencode-unity` adds its rules block to this agent's requests too |

| Three nemici che inseguono, proiettili con Space (2026-10-03, flow of the day before) | 9, none rejected | Space was both jump and shoot in its first version; three test plays showed no Bullet and it fixed it. Final play: `Bullet appeared at 1.1 s …, removed at 1.5 s`, `Enemy2 … removed at 2.0 s` | Colour changes are now reported (`Enemy2 turned red`) |
| A third-person camera (2026-10-03, same flow) | 6, none rejected | Four test plays with turns and moves, read the camera's position from the report | Nothing |
| A moving platform over a hole (2026-10-03, same flow) | 30+ in 29 min | Iterated on riding logic with positions alone: `pushed upward 4 times` was its jitter, `Fell! Reset` its respawn, but it never knew *when* the player fell | A timeline per object: `Player over time: 0.0–0.5 s right to (…); 0.5–0.9 s fell to (…); 0.9 s teleported to (…)` |

### With the plan-and-phases flow (2026-10-03)

| Request | What happened | What it changed |
|---|---|---|
| The moving platform again | Wrote the plan in its own shape (no Idea heading, bold `**Test:**`, bullets under `Expect:`, prose in Italian), got refused twice, then **deleted the forms section** when it rewrote the file and invented forms of its own (`Object "Player" position changed`). Told each line was "not one of the forms at the end of PLAN.md" (which no longer existed), it weakened the lines until phase 2 read `Player moved` three times and everything passed. The code was never tested for riding or respawn | The parser takes plans as models write them; the forms section is put back on every save that drops it, and the forms are carried in the message itself; repeated lines and a phase that expects nothing new are flagged; the forms it reached for exist now: `is above`, `ends at (x, y, z)`, `is reset`, `falls`, `moves back and forth`, a direction at any moment (not only start to end) |
| The double jump again | The full flow, 21 calls: plan kept in the template's shape (Italian prose, English Expect lines), phases 1-3 tested. `proto_test` caught a real bug (`pushed upward 4 times`: the counter reset every frame on the ground, a triple jump), the fix brought it to 3, and the model then corrected its own wrong Expect (`jumps 2 times` → `jumps 3 times`: one jump before landing, two after). Numbers written at the end | Nothing |
| The falling enemies again, "the game stops" | Phases 1-2 passed first time. For phase 3 it wanted `Player does not move after game over` and `no more Enemy appear`, which were not forms, and settled for `Player x > 5` after chasing a random spawn position for three runs. The game did stop (timeline: `1.8–6.0 s still`) but the plan does not prove it | Forms about what happens after the text on screen changes: `Player does not move after the text changes`, `no Enemy appears after the text changes`, `nothing moves after the text changes` |

| The moving platform, third time, with everything above | 39 min, 44 calls, no rejection. Plan with `Player is on Platform`, `Player is reset`, `Player ends at (0, 0.5, 0)`. `proto_test` failed phase 2 (`Player ended at (0.0, 0.5, 0.0), Platform at (5.6, 0.2, 0.0)`, timeline showing a teleport while riding) and phase 3 (`Player never jumped position`), the model fixed the code each time, re-ran all three phases after each fix, caught a regression of phase 2 and fixed it. All three pass with tests that mean something | `Ground, Ground` became `Ground ×2`. Also seen: the sandbox sits inside this repository, and the model grepped the plugin's source for the forms; a classroom machine has no source to read |
| The falling enemies, with the "after the text changes" forms | 10 min, 32 calls. Used `Player does not move after the text changes` and passed. To make the collision test repeatable it moved the spawns onto the player (`±0.75 from player position`): a change to the game made for the test | Test plays now use the same random numbers every time (the probe seeds `Math.random`), so a passing test keeps passing and a value does not have to be chased |

No session made a three.js mistake: all stayed within what the starter game shows. The
`FIX:` lines are therefore verified on broken edits made by hand, not yet on a model's own
mistake.

## Not verified

- **A real Windows machine.** CI runners are clean virtual machines. Not seen: whether the Windows
  firewall asks about a server on 127.0.0.1, a machine where a policy switches off headless mode
  (the plugin then uses the user's tab; `headless: false` forces that route), a real opencode
  session there.
- **Linux outside CI.** On the Ubuntu 24.04 runner Chrome's sandbox starts only after
  `sysctl kernel.apparmor_restrict_unprivileged_userns=0`. A Chrome installed from Google's package
  brings its own AppArmor profile and should not need it; not checked.
- A real opencode 1 session.
- The idle gate in a real session.
- The installer's download route (`irm … | iex`, or `-Version`): only `-Package` runs in CI.
- A model's own three.js mistake being fixed from a `FIX:` line.

## Known limits

- Keyboard only. No mouse, and a captured pointer (first-person look) cannot be simulated with
  synthetic events.
- `FIX:` lines know the names three.js exports and the kit's members, not the members of three.js
  classes: `mesh.setColor(…)` is reported as the browser says it, with file and line, and no fix.
  `proto_lookup` answers the question when the model asks it.
- No documentation search.
- A small model weakens Expect lines rather than fixing code when the forms do not let it say what
  it means. The flagged cases are repeats and unchanged phases; a line that is true but
  meaningless (`Player moves` in a phase about respawn) still passes.
- Test plays share one random seed, so the same code and keys give the same play; frame timing
  still shifts values a little (`8.4` then `8.2`). The user's own tab stays random.
- Whether something is in front of the camera is judged by object centres and a grid of pixels:
  enough to say "nothing is visible", not to say what is.
- Keys are held by the clock, the game advances by frames: on a busy machine a key held for 1 s
  moves the player less (4.3 instead of 5.0 was seen while another browser was working).
- The kit's loop ends at the first error inside it. The report says so, but the user sees a frozen
  game.
- Three files are imported from `packages/opencode-unity/src` (`args.ts`, `runtime.ts`,
  `written-paths.ts`, plus `configDir` and the key-script parser): there is no shared package.
- Not published to npm: the release carries the package for the installer only.

## Next steps

1. Run `install-game-prototype.ps1` from the release on a classroom Windows machine: the
   firewall, a headless policy if there is one, a full session.
2. More sessions on the plan flow, with students' own requests: which Expect forms they reach for
   and do not find, and whether a test that is true but meaningless can be flagged.
3. A harder session, to see a model's own three.js mistakes meet the `FIX:` lines and
   `proto_lookup`.
4. Keep `opencode-unity`'s rules and tools out of `game-prototyper` sessions in a Unity project.
5. The same plan-and-phases flow for `unity-coder`.
5. Mouse clicks in test plays.

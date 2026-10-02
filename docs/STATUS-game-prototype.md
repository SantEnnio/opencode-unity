# opencode-game-prototype: status

Last updated: 2026-10-02. Version 0.1.0, first shipped with the repository's release v0.4.0. The
second plugin of this repository (`packages/opencode-game-prototype`): quick three.js game
prototypes with a small model, checked in a real browser. [STATUS.md](STATUS.md) is about
`opencode-unity`.

## What exists

| Area | State |
|---|---|
| `proto_new`: a prototype that already runs (page, starter game, fixed `vendor/` with three.js r186 and the kit) | Done, verified live. In a Unity or Unreal project it goes in `.prototypes/<name>/`, elsewhere in the folder opencode runs in |
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

No session made a three.js mistake: all three stayed within what the starter game shows. The
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
- `FIX:` lines know the names three.js exports, not the members of its classes: `mesh.setColor(…)`
  is reported as the browser says it, with file and line, and no fix.
- No documentation search and no API lookup tool yet.
- Whether something is in front of the camera is judged by object centres and a grid of pixels:
  enough to say "nothing is visible", not to say what is.
- Random games give different test plays each time.
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
2. `proto_lookup` and a documentation index for three.js (its docs are MIT and can be shipped),
   then fixes for wrong members, not only wrong names.
3. A harder session, to see a model's own three.js mistakes meet the `FIX:` lines.
4. Keep `opencode-unity`'s rules and tools out of `game-prototyper` sessions in a Unity project.
5. Mouse clicks in test plays.

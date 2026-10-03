# opencode-game-prototype

Quick game prototypes with small/local models in [opencode](https://opencode.ai): one feature,
running in the browser with three.js, checked in a real browser after every edit.

A small model writes three.js from memory: classes that were removed years ago, imports that do
not resolve, a camera that looks at nothing. It also cannot see the screen. This plugin loads the
page for it, presses the keys, and puts what happened in the result of the edit it just made.

It is a separate plugin from `opencode-unity` and works in any folder. Inside a Unity or Unreal
project the prototypes go in `.prototypes/<name>/` at the project root, out of the engine's way.

## The flow

1. **Plan.** `proto_new` creates a prototype that already runs (a page, a starter game in
   `main.js`, a fixed `vendor/` with three.js and a small kit) and a `PLAN.md`. The model writes
   the plan: the idea, then phases, each with a `Test` line (the keys to press) and `Expect` lines
   (what must be true afterwards, in a dozen plain-English forms listed in the file). The code
   stays locked until the plan is written.
2. **Build, one phase at a time.** Every edit of a prototype file is loaded in a real browser,
   and the result of the edit carries a `[proto]` report: passed, or the errors with file and
   line and a `FIX:` line when the plugin knows the answer (a three.js or kit name that does not
   exist, an import that cannot resolve, a missing file).
3. **Test and evaluate.** `proto_test` presses each phase's keys in the browser, checks every
   `Expect` line, and answers PASSED or FAILED with what was seen instead (where objects went and
   when, jumps counted, what appeared or was removed, the text on screen). It writes the result
   next to the phase in `PLAN.md`. The idle gate sends the model back when it stops with a phase
   still failing.

Also: `proto_play` for a free test play with keys, `proto_lookup` for the fields and methods of
any three.js class in the shipped version, `proto_status` and `/prototype`, the `game-prototyper`
agent and a short rules block, a guard on `vendor/`.

## How the page is tested

The plugin serves the prototype from a local server (`node:http`, bound to `127.0.0.1`, default
port 4317) and adds a small probe script to the page as it serves it. The test runs in Edge or
Chrome with no window, started for the run and closed after it; nothing is installed. Where no
such browser can run (none found, or headless mode switched off by policy), the test runs in the
tab the user keeps open at the address `proto_new` gives. That tab also reloads on every edit, and
errors that happen in it while the user plays go to the model with the user's next message.

## Install

Works with opencode 1 and opencode 2. It needs Edge or Chrome on the machine, nothing else.

**Windows, from a release** (no Bun, git or administrator rights needed). In PowerShell:

```powershell
irm https://github.com/SantEnnio/opencode-unity/releases/latest/download/install-game-prototype.ps1 | iex
```

Run it again to update. For a classroom, download `install-game-prototype.ps1` and the
`opencode-game-prototype-*.tgz` of a [release](https://github.com/SantEnnio/opencode-unity/releases)
once, put them on a shared drive, and on each machine run
`powershell -ExecutionPolicy Bypass -File install-game-prototype.ps1 -Package opencode-game-prototype-0.1.0.tgz`.
`-Uninstall` removes the plugin. v0.4.0 is the first release that carries this package.

**From a clone of this repository** (any OS, needs [Bun](https://bun.sh)):

```sh
cd packages/opencode-game-prototype
bun install
bun run install:global      # bun run uninstall:global to remove
```

Both put the plugin in `~/.config/opencode/plugins/opencode-game-prototype.js` (on Windows
`%USERPROFILE%\.config\opencode\...`), with its assets in
`~/.config/opencode/opencode-game-prototype/`.

## Options

`~/.config/opencode/opencode-game-prototype/config.json`, or `.opencode/game-prototype.json` in a
project:

| Option | Default | |
|---|---|---|
| `checkOnEdit` | `true` | Load the page in a browser after every edit of a prototype file |
| `planFirst` | `true` | Refuse changes to the code until `PLAN.md` has the idea and a phase with a test |
| `idleGate` | `true` | Send the model back when it stops on a page with errors |
| `idleGateRetries` | `2` | How many times in a row |
| `rules` | `true` | Add the rules block to the system prompt |
| `agent` | `true` | Register the `game-prototyper` agent |
| `headless` | `true` | Run the tests in a browser with no window. `false`: only in the tab the user keeps open |
| `browserPath` | | Edge or Chrome executable, when it is not in the usual place |
| `port` | `4317` | Port of the local server; any free one when it is taken |

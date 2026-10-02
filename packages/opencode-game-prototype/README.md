# opencode-game-prototype

Quick game prototypes with small/local models in [opencode](https://opencode.ai): one feature,
running in the browser with three.js, checked in a real browser after every edit.

A small model writes three.js from memory: classes that were removed years ago, imports that do
not resolve, a camera that looks at nothing. It also cannot see the screen. This plugin loads the
page for it, presses the keys, and puts what happened in the result of the edit it just made.

It is a separate plugin from `opencode-unity` and works in any folder. Inside a Unity or Unreal
project the prototypes go in `.prototypes/<name>/` at the project root, out of the engine's way.

## What it does

- **`proto_new`** creates a prototype that already runs: a page, a starter game (`main.js`) and a
  fixed `vendor/` folder with three.js and a small kit (game loop, keyboard, overlap test, text on
  screen). No npm, no build step, no network: three.js is copied from the plugin.
- **Every edit of a prototype file is loaded in a browser.** The result of the edit carries a
  `[proto]` report: passed, or the errors with file and line, and a `FIX:` line when the plugin
  knows the answer (a three.js name that does not exist, an import that cannot resolve, a file
  that is missing).
- **`proto_play`** runs the game for a few seconds, optionally pressing keys (`"D 1s; Space"`), and
  reports what moved and how far, what appeared or was removed, the text on screen, and whether
  anything is visible at all.
- **`game-prototyper`** agent, a short rules block, `/prototype` for the status, an idle gate that
  sends the model back when it stops on a page with errors, and a guard on `vendor/`.

## How the page is tested

The plugin serves the prototype from a local server (`node:http`, bound to `127.0.0.1`, default
port 4317) and adds a small probe script to the page as it serves it. The test runs in Edge or
Chrome with no window, started for the run and closed after it; nothing is installed. Where no
such browser can run (none found, or headless mode switched off by policy), the test runs in the
tab the user keeps open at the address `proto_new` gives. That tab also reloads on every edit, and
errors that happen in it while the user plays go to the model with the user's next message.

## Install

From a clone of this repository (needs [Bun](https://bun.sh)):

```sh
cd packages/opencode-game-prototype
bun install
bun run install:global      # bun run uninstall:global to remove
```

This puts the plugin in `~/.config/opencode/plugins/opencode-game-prototype.js`, with its assets
in `~/.config/opencode/opencode-game-prototype/`.

## Options

`~/.config/opencode/opencode-game-prototype/config.json`, or `.opencode/game-prototype.json` in a
project:

| Option | Default | |
|---|---|---|
| `checkOnEdit` | `true` | Load the page in a browser after every edit of a prototype file |
| `idleGate` | `true` | Send the model back when it stops on a page with errors |
| `idleGateRetries` | `2` | How many times in a row |
| `rules` | `true` | Add the rules block to the system prompt |
| `agent` | `true` | Register the `game-prototyper` agent |
| `headless` | `true` | Run the tests in a browser with no window. `false`: only in the tab the user keeps open |
| `browserPath` | | Edge or Chrome executable, when it is not in the usual place |
| `port` | `4317` | Port of the local server; any free one when it is taken |

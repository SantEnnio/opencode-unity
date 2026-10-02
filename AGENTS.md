# Instructions for coding agents

## Commits and pull requests

- Never add an AI tool as author or co-author. No `Co-Authored-By:` trailer for Claude, Claude
  Code, opencode or any other assistant, and no "Generated with ..." line in commit messages or
  pull request descriptions. Commits are authored by the human maintainer only.
- Commit or push only when asked.

## Working on this repository

- The plugin lives in `packages/opencode-unity` (TypeScript; one bundle for opencode 1 and 2, on Bun and on Node); the .NET
  symbol exporter in `tools/symbol-exporter`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
  commands and the pitfalls.
- Before calling a change done: `bun test` and `bun run typecheck` in `packages/opencode-unity`.
- `src/index.ts` default-exports `{ id, server, setup }` and nothing else: `server` is the
  opencode 1 plugin (`src/host-v1.ts`), `setup` the opencode 2 one (`src/host-v2.ts`). Logic goes
  in `src/core.ts`, which knows neither API.
- No top-level package imports under `src/`: opencode 2 gives plugins no packages.
  `@opencode-ai/plugin` is imported inside `server` only; tool arguments go through `src/args.ts`.
- No Bun-only APIs under `src/` (`Bun.*`, `bun:*` imports, `import.meta.dir`): opencode 1 desktop
  runs plugins on Node inside Electron, opencode 1 CLI and opencode 2 on Bun. Use `src/runtime.ts`
  for processes and `src/sqlite.ts` for SQLite. `bun run test:node` checks the bundle under both
  plugin APIs, on Node and on Bun.
- Text the model reads (tool descriptions, reports, hints, rules) targets small local models:
  short, imperative, ending with the exact next step.
- No shell strings: spawn processes with argument arrays and build paths with `node:path`. The
  code must run on Windows, macOS and Linux.
- Read `docs/STATUS.md` before starting (what is done, verified, broken) and update it when that
  changes. `docs/small-model-tool-design.md` holds the rules for anything a model reads or calls.
- A second plugin, `packages/opencode-game-prototype` (three.js game prototypes, checked in a real
  browser), follows the same rules. It imports `args.ts`, `runtime.ts`, `written-paths.ts`,
  `configDir` and `probe/keys.ts` from `packages/opencode-unity/src`: a change to those must keep
  both packages green. Its checks are `bun test`, `bun run typecheck` and `bun run test:node` in
  its own folder; `bun test` there starts Edge or Chrome with no window when one is installed.
  Its status page is `docs/STATUS-game-prototype.md`.
- `sandbox/` is git-ignored scratch space for throwaway Unity projects. Never point tests at a
  real user project.

# Instructions for coding agents

## Commits and pull requests

- Never add an AI tool as author or co-author. No `Co-Authored-By:` trailer for Claude, Claude
  Code, opencode or any other assistant, and no "Generated with ..." line in commit messages or
  pull request descriptions. Commits are authored by the human maintainer only.
- Commit or push only when asked.

## Working on this repository

- The plugin lives in `packages/opencode-unity` (TypeScript; runs on Bun in the opencode CLI and on Node in opencode desktop); the .NET
  symbol exporter in `tools/symbol-exporter`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
  commands and the pitfalls.
- Before calling a change done: `bun test` and `bun run typecheck` in `packages/opencode-unity`.
- `src/index.ts` must export the plugin function and nothing else.
- No Bun-only APIs under `src/` (`Bun.*`, `bun:*` imports, `import.meta.dir`): opencode desktop
  runs plugins on Node inside Electron, the CLI on Bun. Use `src/runtime.ts` for processes and
  `src/sqlite.ts` for SQLite. `bun run test:node` checks the bundle on plain Node.
- Text the model reads (tool descriptions, reports, hints, rules) targets small local models:
  short, imperative, ending with the exact next step.
- No shell strings: spawn processes with argument arrays and build paths with `node:path`. The
  code must run on Windows, macOS and Linux.
- `sandbox/` is git-ignored scratch space for throwaway Unity projects. Never point tests at a
  real user project.

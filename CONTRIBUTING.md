# Contributing

```sh
cd packages/opencode-unity
bun install
bun run build:exporter   # needs the .NET SDK
bun test
bun run test:node       # the bundle on plain Node
bun run typecheck
```

A few things that are easy to get wrong:

- One bundle serves opencode 1 and opencode 2. `src/index.ts` default-exports
  `{ id, server, setup }` and nothing else: opencode 1 calls `server` (`src/host-v1.ts`), opencode 2
  calls `setup` (`src/host-v2.ts`), and opencode 1 treats any other export as a plugin. Everything
  else lives in `src/core.ts`, which knows neither API.
- opencode 2 gives plugins no packages: nothing may import a package at the top of a module.
  `@opencode-ai/plugin` is loaded inside `server` only. Tool arguments are described once in
  `src/args.ts` and turned into zod (opencode 1) or JSON Schema (opencode 2).
- opencode 2 fails the whole step when a hook or a tool throws: return the error as text instead.
- opencode 1 desktop runs plugins on Node (Electron); opencode 1 CLI and opencode 2 run them on
  Bun. Nothing under `src/` may use Bun-only APIs: go through `src/runtime.ts` and `src/sqlite.ts`,
  and run `bun run test:node`, which loads the bundle under both APIs on Node and on Bun.
- Everything the model reads (tool descriptions, reports, hints) is written for a small model:
  short, imperative, and ending with the exact next step. Longer is not better.
- Prefer enforcing a rule in a hook over describing it in the rules block.
- No shell strings. Spawn processes with argument arrays and build paths with `node:path`, so the
  same code runs on Windows, macOS and Linux.
- Compiler messages are parsed in English: keep `DOTNET_CLI_UI_LANGUAGE=en` on every `dotnet` call.

Bug reports are most useful with the compiler error, the hint the plugin produced (or did not),
the Unity version, and the OS.

## Releasing

1. Set the new version in `packages/opencode-unity/package.json` and commit it.
2. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.

The `Release` workflow runs the full CI, builds the package (`npm pack`) and attaches it to a GitHub
release. Publishing to npm, with provenance, is off until the repository variable `NPM_PUBLISH` is
set to `true`. A tag with a pre-release suffix (`v0.2.0-beta.1`)
becomes a GitHub pre-release and the npm `next` tag. The workflow needs an npm granular access token with
"Bypass two-factor authentication" enabled, in the repository secret `NPM_TOKEN`. A failed run can
be re-run: the existing GitHub release is updated, not duplicated.

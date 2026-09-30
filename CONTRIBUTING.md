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

- `src/index.ts` must export the plugin function and nothing else: opencode calls every export
  of a plugin module as a plugin.
- opencode desktop runs plugins on Node (Electron), the CLI on Bun. Nothing under `src/` may use
  Bun-only APIs: go through `src/runtime.ts` and `src/sqlite.ts`, and run `bun run test:node`.
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

The `Release` workflow runs the full CI, builds the package (`npm pack`), attaches it to a GitHub
release and publishes it to npm with provenance. A tag with a pre-release suffix (`v0.2.0-beta.1`)
becomes a GitHub pre-release and the npm `next` tag. The workflow needs an npm granular access token with
"Bypass two-factor authentication" enabled, in the repository secret `NPM_TOKEN`. A failed run can
be re-run: the existing GitHub release is updated, not duplicated.

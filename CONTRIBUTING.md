# Contributing

```sh
cd packages/opencode-unity
bun install
bun run build:exporter   # needs the .NET SDK
bun test
bun run typecheck
```

A few things that are easy to get wrong:

- `src/index.ts` must export the plugin function and nothing else: opencode calls every export
  of a plugin module as a plugin.
- Everything the model reads (tool descriptions, reports, hints) is written for a small model:
  short, imperative, and ending with the exact next step. Longer is not better.
- Prefer enforcing a rule in a hook over describing it in the rules block.
- No shell strings. Spawn processes with argument arrays and build paths with `node:path`, so the
  same code runs on Windows, macOS and Linux.
- Compiler messages are parsed in English: keep `DOTNET_CLI_UI_LANGUAGE=en` on every `dotnet` call.

Bug reports are most useful with the compiler error, the hint the plugin produced (or did not),
the Unity version, and the OS.

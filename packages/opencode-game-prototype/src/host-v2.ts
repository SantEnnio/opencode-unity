// opencode 2: the core behind the v2 plugin API. Written against opencode 2.0.20. The types below
// are the few parts of `@opencode/plugin` this file uses: opencode 2 gives plugins no packages, so
// nothing is imported from it at runtime.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { toJsonSchema } from "../../opencode-unity/src/args.ts"
import { createPrototypes, type Log, PROTO_COMMANDS } from "./core.ts"

type Content = string | ReadonlyArray<{ type: string; text?: string }>
type ToolResult = { content?: Content; output?: unknown; metadata?: Record<string, unknown> }
type Registration = { dispose(): Promise<void> }
type V2Message = { id?: string; role: string; content: ReadonlyArray<unknown> }

type V2Context = {
  location: { directory: string }
  options: Record<string, unknown>
  tool: {
    transform(callback: (tools: { add(tool: Record<string, unknown>): void }) => void): Promise<Registration>
    hook(name: "execute.before", callback: (event: { tool: string; sessionID: string; input: unknown }) => void | Promise<void>): Promise<Registration>
    hook(
      name: "execute.after",
      callback: (event: { tool: string; sessionID: string; input: unknown; status: "completed" | "error"; result?: ToolResult }) => void | Promise<void>,
    ): Promise<Registration>
  }
  session: {
    hook(name: "prompt", callback: (event: { sessionID: string; messageID: string; metadata?: Record<string, unknown> }) => void | Promise<void>): Promise<Registration>
    hook(name: "context", callback: (event: { sessionID: string; agent: string; system: { type: "text"; text: string }[]; messages: V2Message[] }) => void | Promise<void>): Promise<Registration>
    prompt(input: { sessionID: string; text: string; delivery?: unknown }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string; description?: string; metadata?: Record<string, unknown> }): Promise<unknown>
  }
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }> }
  agent: {
    transform(
      callback: (editor: {
        get(id: string): unknown
        update(id: string, update: (agent: { name: string; description?: string; mode: string; system?: string; request: { body: Record<string, unknown> } }) => void): void
      }) => void,
    ): Promise<Registration>
  }
  command: {
    transform(
      callback: (editor: { add(command: { name: string; description?: string; execute(input: { sessionID: string; delivery: unknown }): Promise<void> }): void }) => void,
    ): Promise<Registration>
  }
}

// Marks messages the plugin sends itself, so they do not count as the user speaking.
const OWN = "opencodeGamePrototype"

// Throwing inside a hook or a tool fails the whole step in opencode 2, and a hook cannot refuse a
// call either. A blocked write is therefore redirected to this tool, which only states the reason.
const BLOCKED_TOOL = "proto_blocked"

const logDir = () =>
  process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "opencode-game-prototype")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "opencode-game-prototype")
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode-game-prototype")

export async function setup(ctx: V2Context) {
  const logFile = path.join(logDir(), "opencode-game-prototype.log")
  // opencode 2 gives plugins no log API: one line per event in our own file.
  const log: Log = (level, message) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {}
  }

  const directory = ctx.location.directory
  const proto = createPrototypes(directory, ctx.options, log)
  if (!proto) return

  const disposables: Registration[] = []
  const stop = new AbortController()

  disposables.push(
    await ctx.tool.transform((tools) => {
      for (const [name, spec] of Object.entries(proto.tools)) {
        tools.add({
          name,
          description: spec.description,
          input: toJsonSchema(spec.args),
          // Native tools: a small model cannot drive them through Code Mode.
          options: { codemode: false },
          async execute(input: Record<string, unknown>, context: { sessionID: string; signal: AbortSignal }): Promise<ToolResult> {
            try {
              return { content: await spec.execute(input as never, { directory, sessionID: context.sessionID, abort: context.signal, consent: async () => null }) }
            } catch (error) {
              log("error", `${name} failed: ${error instanceof Error ? error.stack : String(error)}`)
              return { content: `[proto] ${name} failed: ${error instanceof Error ? error.message : String(error)}` }
            }
          },
        })
      }
      tools.add({
        name: BLOCKED_TOOL,
        description: "Never call this tool. opencode-game-prototype uses it to explain why a file write was refused.",
        input: { type: "object", properties: { reason: { type: "string" } } },
        options: { codemode: false },
        execute: async (input: { reason?: string }) => ({ content: input.reason ?? "[proto] Blocked." }),
      })
    }),
  )

  disposables.push(
    await ctx.tool.hook("execute.before", (event) => {
      const blocked = proto.guardWrite(event.tool, event.input, directory, event.sessionID)
      if (!blocked) return
      event.tool = BLOCKED_TOOL
      event.input = { reason: blocked }
    }),
  )

  disposables.push(
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || !event.result) return
      const report = await proto.afterWrite(event.tool, event.input, event.sessionID, directory)
      if (!report) return
      const content = event.result.content ?? []
      event.result = {
        ...event.result,
        content: typeof content === "string" ? `${content}\n\n${report}` : [...content, { type: "text", text: report }],
      }
    }),
  )

  disposables.push(
    await ctx.session.hook("prompt", (event) => {
      if (event.metadata?.[OWN]) return
      proto.userMessage(event.sessionID, {}, event.messageID)
    }),
  )

  // Changes here reach one model request only; opencode 2 never stores them in the session.
  disposables.push(
    await ctx.session.hook("context", (event) => {
      const rules = proto.rules(event.sessionID, event.agent)
      if (rules) event.system.push({ type: "text", text: rules })
      // The note goes at the end, on the user's message: text that changes near the top of a
      // request makes a local server reprocess the whole context instead of reusing its cache.
      const note = proto.playNote(event.sessionID)
      if (!note) return
      let index = event.messages.findIndex((m) => note.messageID !== undefined && m.id === note.messageID)
      if (index < 0) index = event.messages.findLastIndex((m) => m.role === "user")
      const message = event.messages[index]
      if (!message) return
      // Same prototype, so opencode still sees its own message class.
      event.messages[index] = Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
        content: [...message.content, { type: "text", text: note.text }],
      })
    }),
  )

  disposables.push(
    await ctx.command.transform((editor) => {
      for (const command of PROTO_COMMANDS) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, delivery }) => void (await ctx.session.prompt({ sessionID, text: command.template, delivery })),
        })
      }
    }),
  )

  const agent = proto.agent
  if (agent) {
    disposables.push(
      await ctx.agent.transform((editor) => {
        const configured = editor.get(agent.name) !== undefined
        editor.update(agent.name, (item) => {
          // An agent of the same name in the user's config wins, field by field.
          if (!configured) item.name = agent.name
          item.description ??= agent.description
          item.system ??= agent.prompt
          item.request.body.temperature ??= agent.temperature
          if (!configured) item.mode = "primary"
        })
      }),
    )
  }

  // The idle gate: when a session settles while the page has errors, send the model back once more.
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      if (event.type !== "session.execution.succeeded" || !event.data?.sessionID) continue
      const nudge = proto.idle(event.data.sessionID)
      if (!nudge) continue
      await ctx.session
        .synthetic({ sessionID: event.data.sessionID, text: nudge.text, description: "opencode-game-prototype: the prototype has errors", metadata: { [OWN]: true } })
        .catch((error: unknown) => log("error", `idle gate could not re-prompt: ${String(error)}`))
    }
  })().catch((error: unknown) => {
    if (!stop.signal.aborted) log("error", `event stream closed: ${String(error)}`)
  })

  return async () => {
    stop.abort()
    await proto.dispose()
    await Promise.all(disposables.map((registration) => registration.dispose().catch(() => {})))
  }
}

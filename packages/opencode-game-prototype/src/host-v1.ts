// opencode 1 (the 1.x CLI and desktop): the core behind the v1 hooks.

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { toZodShape } from "../../opencode-unity/src/args.ts"
import { createPrototypes, PROTO_COMMAND } from "./core.ts"

export async function server({ client, directory }: PluginInput, rawOptions?: unknown): Promise<Hooks> {
  const log = (level: "info" | "warn" | "error", message: string) =>
    void client.app.log({ body: { service: "opencode-game-prototype", level, message } }).catch(() => {})

  const proto = createPrototypes(directory, rawOptions, log)
  if (!proto) return {}

  // Loaded here, not at the top of the module: opencode 2 gives plugins no packages, and it must
  // be able to import this file. The zod inside is opencode 1's own, which its tool schemas need.
  const { tool } = await import("@opencode-ai/plugin")

  const tools: NonNullable<Hooks["tool"]> = {}
  for (const [name, spec] of Object.entries(proto.tools)) {
    tools[name] = tool({
      description: spec.description,
      args: toZodShape(tool.schema, spec.args),
      // Nothing here changes the user's project behind their back: no consent to ask for.
      execute: (args, context) => spec.execute(args, { directory: context.directory, sessionID: context.sessionID, abort: context.abort, consent: async () => null }),
    })
  }

  return {
    tool: tools,

    "tool.execute.before": async (input, output) => {
      const blocked = proto.guardWrite(input.tool, output.args, directory)
      if (blocked) throw new Error(blocked)
    },

    "tool.execute.after": async (input, output) => {
      const report = await proto.afterWrite(input.tool, input.args, input.sessionID, directory)
      if (report) output.output = `${output.output}\n\n${report}`
    },

    "chat.message": async (input, output) => {
      proto.userMessage(input.sessionID, { agent: input.agent, model: input.model }, output.message.id)
    },

    // What the user's tab showed joins the request only, never the stored session.
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages.at(-1)?.info.sessionID
      const note = sessionID ? proto.playNote(sessionID) : null
      if (!note) return
      const target = output.messages.find((m) => m.info.id === note.messageID) ?? output.messages.findLast((m) => m.info.role === "user")
      if (!target) return
      target.parts.push({ id: "prt_opencode_game_prototype_tab", sessionID: target.info.sessionID, messageID: target.info.id, type: "text", text: note.text, synthetic: true })
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") proto.forget(event.properties.info.id)
      if (event.type !== "session.idle") return
      const nudge = proto.idle(event.properties.sessionID)
      if (!nudge) return
      await client.session
        .promptAsync({
          path: { id: event.properties.sessionID },
          body: { agent: nudge.agent, model: nudge.model, parts: [{ type: "text", text: nudge.text }] },
        })
        .catch((error: unknown) => log("error", `idle gate could not re-prompt: ${String(error)}`))
    },

    config: async (config) => {
      config.command = {
        ...config.command,
        [PROTO_COMMAND.name]: { description: PROTO_COMMAND.description, template: PROTO_COMMAND.template, ...config.command?.[PROTO_COMMAND.name] },
      }
      if (!proto.agent) return
      const { name, description, temperature, prompt } = proto.agent
      config.agent = { ...config.agent, [name]: { description, mode: "primary", temperature, prompt, ...config.agent?.[name] } }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const rules = proto.rules(input.sessionID)
      if (rules) output.system.push(rules)
    },
  }
}

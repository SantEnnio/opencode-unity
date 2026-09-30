// opencode 1 (the 1.x CLI and desktop): the core behind the v1 hooks.

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { toZodShape } from "./args.ts"
import { createUnity, UNITY_COMMAND } from "./core.ts"

export async function server({ client, directory }: PluginInput, rawOptions?: unknown): Promise<Hooks> {
  const log = (level: "info" | "warn" | "error", message: string) =>
    void client.app.log({ body: { service: "opencode-unity", level, message } }).catch(() => {})

  const unity = createUnity(directory, rawOptions, log)
  if (!unity) return {}

  // Loaded here, not at the top of the module: opencode 2 gives plugins no packages, and it must
  // be able to import this file. The zod inside is opencode 1's own, which its tool schemas need.
  const { tool } = await import("@opencode-ai/plugin")

  void client.tui
    .showToast({ body: { title: "opencode-unity", message: `Active on Unity ${unity.project.version}. /unity shows the status.`, variant: "success", duration: 4000 } })
    .catch(() => {})

  const tools: NonNullable<Hooks["tool"]> = {}
  for (const [name, spec] of Object.entries(unity.tools)) {
    tools[name] = tool({
      description: spec.description,
      args: toZodShape(tool.schema, spec.args),
      execute: (args, context) =>
        spec.execute(args, {
          directory: context.directory,
          sessionID: context.sessionID,
          abort: context.abort,
          async consent(request) {
            try {
              await context.ask({ permission: request.permission, patterns: request.patterns, always: request.patterns, metadata: request.metadata })
              return null
            } catch {
              return "[unity] The user did not approve it. Do not try again unless they ask."
            }
          },
        }),
    })
  }

  return {
    tool: tools,

    "tool.execute.before": async (input, output) => {
      const blocked = unity.guardWrite(input.tool, output.args, directory)
      if (blocked) throw new Error(blocked)
    },

    "tool.execute.after": async (input, output) => {
      const report = await unity.afterWrite(input.tool, input.args, input.sessionID, directory)
      if (report) output.output = `${output.output}\n\n${report}`
    },

    "chat.message": async (input) => {
      unity.userMessage(input.sessionID, { agent: input.agent, model: input.model })
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") unity.forget(event.properties.info.id)
      if (event.type !== "session.idle") return
      const nudge = unity.idle(event.properties.sessionID)
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
        [UNITY_COMMAND.name]: { description: UNITY_COMMAND.description, template: UNITY_COMMAND.template, ...config.command?.[UNITY_COMMAND.name] },
      }
      if (!unity.agent) return
      const { name, description, temperature, prompt } = unity.agent
      config.agent = { ...config.agent, [name]: { description, mode: "primary", temperature, prompt, ...config.agent?.[name] } }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const rules = unity.rules()
      if (rules) output.system.push(rules)
    },
  }
}

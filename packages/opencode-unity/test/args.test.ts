import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { arg, optional, toJsonSchema, toZodShape } from "../src/args.ts"
import { writtenPaths } from "../src/written-paths.ts"

// The zod opencode 1 hands to plugins.
const z = tool.schema

const args = {
  path: arg.string("Hierarchy path"),
  mode: arg.enum(["EditMode", "PlayMode"], "Test mode"),
  count: optional(arg.number("How many", { integer: true, min: 1, max: 50 })),
  active: optional(arg.boolean("Shown or hidden")),
}

describe("tool arguments", () => {
  test("JSON Schema for opencode 2", () => {
    expect(toJsonSchema(args)).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "Hierarchy path" },
        mode: { type: "string", enum: ["EditMode", "PlayMode"], description: "Test mode" },
        count: { type: "integer", minimum: 1, maximum: 50, description: "How many" },
        active: { type: "boolean", description: "Shown or hidden" },
      },
      required: ["path", "mode"],
    })
    expect(toJsonSchema({})).toEqual({ type: "object", properties: {} })
  })

  test("zod shape for opencode 1 validates the same things", () => {
    const schema = z.object(toZodShape(z, args))
    expect(schema.safeParse({ path: "/Car", mode: "EditMode" }).success).toBe(true)
    expect(schema.safeParse({ path: "/Car", mode: "EditMode", count: 3, active: false }).success).toBe(true)
    expect(schema.safeParse({ mode: "EditMode" }).success).toBe(false)
    expect(schema.safeParse({ path: "/Car", mode: "Other" }).success).toBe(false)
    expect(schema.safeParse({ path: "/Car", mode: "EditMode", count: 1.5 }).success).toBe(false)
    expect(schema.safeParse({ path: "/Car", mode: "EditMode", count: 51 }).success).toBe(false)
  })
})

describe("written paths", () => {
  test("opencode 1 filePath and opencode 2 path", () => {
    expect(writtenPaths("write", { filePath: "Assets/A.cs" }, "/p")).toEqual([path.resolve("/p", "Assets/A.cs")])
    expect(writtenPaths("edit", { path: "Assets/B.cs" }, "/p")).toEqual([path.resolve("/p", "Assets/B.cs")])
    expect(writtenPaths("patch", { patchText: "*** Update File: Assets/C.cs\n" }, "/p")).toEqual([path.resolve("/p", "Assets/C.cs")])
    expect(writtenPaths("read", { path: "Assets/D.cs" }, "/p")).toEqual([])
  })
})

// Tool arguments described once, turned into what each opencode generation wants: zod shapes for
// opencode 1 (its own zod instance, passed in), JSON Schema for opencode 2 (which gives plugins no
// dependencies at all).

type Base = { description?: string; optional?: boolean }

export type Arg =
  | (Base & { type: "string"; enum?: readonly string[] })
  | (Base & { type: "number"; integer?: boolean; min?: number; max?: number })
  | (Base & { type: "boolean" })
  // A schema the simple kinds cannot express. `value` only carries the TypeScript type.
  | (Base & { type: "raw"; json: Record<string, unknown>; zod: (z: any) => any; value?: unknown })

export type Args = Record<string, Arg>

type Value<A> = A extends { type: "string"; enum: readonly (infer E)[] }
  ? E
  : A extends { type: "string" }
    ? string
    : A extends { type: "number" }
      ? number
      : A extends { type: "boolean" }
        ? boolean
        : A extends { type: "raw"; value?: infer V }
          ? V
          : never

type Required<S extends Args> = { [K in keyof S as S[K] extends { optional: true } ? never : K]: Value<S[K]> }
type Optional<S extends Args> = { [K in keyof S as S[K] extends { optional: true } ? K : never]?: Value<S[K]> }
export type Infer<S extends Args> = Required<S> & Optional<S>

export const arg = {
  string: (description: string) => ({ type: "string", description }) as const,
  enum: <const E extends readonly string[]>(values: E, description: string) => ({ type: "string", enum: values, description }) as const,
  number: (description: string, limits: { integer?: boolean; min?: number; max?: number } = {}) => ({ type: "number", description, ...limits }) as const,
  boolean: (description: string) => ({ type: "boolean", description }) as const,
  raw: <V>(json: Record<string, unknown>, zod: (z: any) => any, description: string) =>
    ({ type: "raw", json, zod, description }) as { type: "raw"; json: Record<string, unknown>; zod: (z: any) => any; description: string; value?: V },
}

export const optional = <A extends Arg>(a: A): A & { optional: true } => ({ ...a, optional: true })

/** A zod raw shape built with the host's zod (`tool.schema` in opencode 1). */
export function toZodShape(z: any, args: Args): Record<string, any> {
  const shape: Record<string, any> = {}
  for (const [name, a] of Object.entries(args)) {
    let schema: any
    if (a.type === "string") schema = a.enum ? z.enum(a.enum) : z.string()
    else if (a.type === "number") {
      schema = z.number()
      if (a.integer) schema = schema.int()
      if (a.min !== undefined) schema = schema.min(a.min)
      if (a.max !== undefined) schema = schema.max(a.max)
    } else if (a.type === "boolean") schema = z.boolean()
    else schema = a.zod(z)
    if (a.optional) schema = schema.optional()
    if (a.description) schema = schema.describe(a.description)
    shape[name] = schema
  }
  return shape
}

export function toJsonSchema(args: Args): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, a] of Object.entries(args)) {
    const description = a.description ? { description: a.description } : {}
    if (a.type === "string") properties[name] = { type: "string", ...(a.enum && { enum: [...a.enum] }), ...description }
    else if (a.type === "number") {
      properties[name] = {
        type: a.integer ? "integer" : "number",
        ...(a.min !== undefined && { minimum: a.min }),
        ...(a.max !== undefined && { maximum: a.max }),
        ...description,
      }
    } else if (a.type === "boolean") properties[name] = { type: "boolean", ...description }
    else properties[name] = { ...a.json, ...description }
    if (!a.optional) required.push(name)
  }
  return { type: "object", properties, ...(required.length > 0 && { required }) }
}

/** What a tool gets from the host, whichever opencode runs it. */
export type ToolContext = {
  directory: string
  sessionID: string
  abort: AbortSignal
  /**
   * Asks the user before an action that changes their project. Resolves to null when approved,
   * or to the text to answer the model with when not (yet) approved.
   */
  consent(request: { permission: string; question: string; patterns: string[]; metadata: Record<string, unknown> }): Promise<string | null>
}

export type ToolSpec<S extends Args = Args> = {
  description: string
  args: S
  execute(args: Infer<S>, context: ToolContext): Promise<string>
}

/** Identity: only here so `args` types the `execute` parameters. */
export function defineTool<const S extends Args>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec
}

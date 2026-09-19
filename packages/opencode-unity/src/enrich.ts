// Turns compiler errors into hints backed by the symbol graph. A small model will not go and
// look up the real API on its own, so the lookup is done for it and the answer is attached
// to the error it has to fix.

import type { Diagnostic } from "./compile/diagnostics.ts"
import { type GraphMember, type GraphType, stripGenerics, type SymbolGraph } from "./graph/db.ts"

export type SourceReader = {
  /** Content of a project-relative source file, or null when it cannot be read */
  text(file: string): string | null
}

export type Callee = { name: string; receiver: string | null }

// Members every MonoBehaviour inherits and that models use as implicit receivers.
const IMPLICIT_RECEIVERS: Record<string, string> = {
  transform: "UnityEngine.Transform",
  gameObject: "UnityEngine.GameObject",
}

const MAX_SUGGESTIONS = 5
const MAX_OVERLOADS = 8
const MAX_ENUM_VALUES = 24

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
    }
    previous = current
  }
  return previous[b.length]!
}

const words = (identifier: string) =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)

/** Lower is closer; null means unrelated. */
export function similarity(candidate: string, wanted: string): number | null {
  const c = candidate.toLowerCase()
  const w = wanted.toLowerCase()
  if (c === w) return 0
  if (c.includes(w) || w.includes(c)) return 1 + Math.abs(c.length - w.length) / 100

  const candidateWords = new Set(words(candidate))
  const wantedWords = words(wanted)
  const shared = wantedWords.filter((word) => candidateWords.has(word)).length
  if (shared > 0) return 2 - shared / Math.max(candidateWords.size, wantedWords.length)

  const distance = levenshtein(c, w) / Math.max(c.length, w.length)
  return distance <= 0.4 ? 3 + distance : null
}

function describe(member: GraphMember): string {
  let text = member.sig
  if (member.obsolete !== null) text += `  [OBSOLETE${member.replacement ? `, use ${member.replacement}` : ""}]`
  else if (member.summary) text += `  // ${firstSentence(member.summary)}`
  return text
}

function firstSentence(text: string): string {
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence
}

export function suggestMembers(members: GraphMember[], wanted: string, limit = MAX_SUGGESTIONS): GraphMember[] {
  const best = new Map<string, { member: GraphMember; score: number }>()
  for (const member of members) {
    if (member.kind === "ctor") continue
    const score = similarity(member.name, wanted)
    if (score === null) continue
    // Obsolete members stay visible (the model may have meant them) but rank below live ones.
    const ranked = score + (member.obsolete !== null ? 0.5 : 0)
    const existing = best.get(member.name)
    if (!existing || ranked < existing.score) best.set(member.name, { member, score: ranked })
  }
  return [...best.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.member)
}

/** "Object.FindObjectOfType<T>()" -> { type: "Object", member: "FindObjectOfType" } */
export function splitSymbol(symbol: string): { type: string; member: string | null } {
  const bare = stripGenerics(symbol.replace(/\(.*$/, ""))
  const dot = bare.lastIndexOf(".")
  return dot < 0 ? { type: bare, member: null } : { type: bare.slice(0, dot), member: bare.slice(dot + 1) }
}

/** The call whose argument list contains the given column (1-based): `rb.AddForce(` -> AddForce on rb. */
export function calleeAt(sourceLine: string, column: number): Callee | null {
  let depth = 0
  for (let i = Math.min(column - 2, sourceLine.length - 1); i >= 0; i--) {
    const c = sourceLine[i]
    if (c === ")") depth++
    else if (c === "(") {
      if (depth > 0) {
        depth--
        continue
      }
      const before = stripGenerics(sourceLine.slice(0, i)).trimEnd()
      const match = /(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)$/.exec(before)
      return match ? { name: match[2]!, receiver: match[1] ?? null } : null
    }
  }
  return null
}

/** Declared type of a field, local or parameter, found by looking for `Type name` in the file. */
export function declaredType(source: string, identifier: string): string | null {
  const declaration = new RegExp(`\\b([A-Z][\\w.]*(?:<[^>;()]+>)?(?:\\[\\])?)\\s+${identifier}\\s*(?:[;=,)]|$)`, "m")
  return declaration.exec(source)?.[1] ?? null
}

export class Enricher {
  constructor(
    private readonly graph: SymbolGraph,
    private readonly source: SourceReader,
  ) {}

  hints(d: Diagnostic): string[] {
    switch (d.code) {
      case "CS1061":
      case "CS0117":
        return this.missingMember(d)
      case "CS0246":
      case "CS0103":
      case "CS0234":
        return this.missingType(d)
      case "CS0618":
      case "CS0619":
      case "CS0612":
        return this.obsolete(d)
      case "CS1501":
      case "CS7036":
      case "CS1503":
      case "CS1739":
        return this.wrongArguments(d)
      case "CS0122":
        return this.inaccessible(d)
      default:
        return []
    }
  }

  private usings(file: string): string[] {
    const text = this.source.text(file) ?? ""
    return [...text.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)].map((m) => m[1]!)
  }

  private inaccessible(d: Diagnostic): string[] {
    const symbol = /'([^']+)' is inaccessible/.exec(d.message)?.[1]
    if (!symbol) return []
    const { type, member } = splitSymbol(symbol)
    // Only the user's own code can be fixed by changing the declaration.
    if (this.graph.findTypes(type).length > 0) return [`${symbol} is not public in Unity: it cannot be called from your code.`]
    return [`${member ?? type} is private. Declare it \`public\` (or \`internal\`) in ${type}, or call it from inside ${type}.`]
  }

  /** Types matching a name as the compiler printed it, narrowed by the file's using directives. */
  private resolveTypes(name: string, file: string): GraphType[] {
    const candidates = this.graph.findTypes(name)
    if (candidates.length <= 1) return candidates
    const usings = new Set(this.usings(file))
    const imported = candidates.filter((t) => usings.has(t.ns))
    return (imported.length > 0 ? imported : candidates).slice(0, 2)
  }

  private missingMember(d: Diagnostic): string[] {
    const match = /'([^']+)' does not contain a definition for '([^']+)'/.exec(d.message)
    if (!match) return []
    const [, typeName, wanted] = match as unknown as [string, string, string]

    const hints: string[] = []
    for (const type of this.resolveTypes(typeName, d.file)) {
      const members = this.graph.membersOf(type)
      if (type.kind === "enum") {
        const values = members.filter((m) => m.kind === "enumvalue" && m.obsolete === null).map((m) => m.name)
        if (values.length <= MAX_ENUM_VALUES) {
          hints.push(`${type.name}.${wanted} does not exist. The only ${type.name} values are: ${values.join(", ")}.`)
          continue
        }
      }

      const suggestions = suggestMembers(members, wanted)
      if (suggestions.length === 0) {
        hints.push(`${type.full} has no member similar to '${wanted}'. Do not guess: use a member that exists.`)
        continue
      }
      hints.push(`${type.full} has no member '${wanted}'. Closest real members:`)
      for (const member of suggestions) hints.push(`  ${describe(member)}`)
    }
    return hints
  }

  private missingType(d: Diagnostic): string[] {
    const match =
      /The (?:type or namespace )?name '([^']+)' (?:could not be found|does not exist)/.exec(d.message) ??
      /The type or namespace name '([^']+)' does not exist in the namespace/.exec(d.message)
    if (!match) return []
    const name = stripGenerics(match[1]!)

    const types = this.graph.findTypes(name).filter((t) => t.simple === name)
    if (types.length === 0) {
      // CS0103 is also raised for plain undeclared variables: only speak up when a type was expected.
      if (d.code === "CS0103") return []
      return [
        `No type named '${name}' exists in this Unity version or in the installed packages. If it is meant to be your own class, create it; otherwise it does not exist.`,
      ]
    }

    const usings = new Set(this.usings(d.file))
    const missing = types.filter((t) => t.ns.length > 0 && !usings.has(t.ns))
    if (missing.length === 0) {
      const assemblies = [...new Set(types.map((t) => t.asm))].join(", ")
      return [
        `'${name}' exists (assembly ${assemblies}) and its namespace is already imported: the assembly of this script does not reference it (check the .asmdef references, or that the package is installed).`,
      ]
    }
    return missing
      .slice(0, 3)
      .map((t) => `Add \`using ${t.ns};\` at the top of the file ('${name}' is ${t.full}, assembly ${t.asm}).`)
  }

  private obsolete(d: Diagnostic): string[] {
    const match = /'([^']+)' is obsolete/.exec(d.message)
    if (!match) return []
    const { type: typeName, member: memberName } = splitSymbol(match[1]!)

    for (const type of this.resolveTypes(memberName ? typeName : match[1]!, d.file)) {
      if (!memberName) {
        if (type.replacement) return [`Replace ${type.name} with ${type.replacement}.`]
        continue
      }
      const members = this.graph.membersOf(type)
      const replacement = members.find((m) => m.name === memberName && m.replacement)?.replacement
      if (!replacement) continue

      const replacementName = replacement.slice(replacement.lastIndexOf(".") + 1)
      const signatures = members.filter((m) => m.name === replacementName && m.obsolete === null)
      const hints = [`Replace ${memberName} with ${replacement}.`]
      for (const member of signatures.slice(0, 3)) hints.push(`  ${describe(member)}`)
      return hints
    }
    return []
  }

  private wrongArguments(d: Diagnostic): string[] {
    let typeName: string | null = null
    let methodName: string | null = null

    const qualified = /of '([^']+\([^']*\))'/.exec(d.message)
    const named = /No overload for method '([^']+)'/.exec(d.message) ?? /The best overload for '([^']+)'/.exec(d.message)
    if (qualified) {
      const symbol = splitSymbol(qualified[1]!)
      typeName = symbol.member ? symbol.type : null
      methodName = symbol.member ?? symbol.type
    } else if (named) {
      methodName = named[1]!
    } else {
      const text = this.source.text(d.file)
      const callee = calleeAt(text?.split(/\r?\n/)[d.line - 1] ?? "", d.column)
      methodName = callee?.name ?? null
      if (text && callee?.receiver) {
        // `Physics.Raycast(` names the type itself; `rb.AddForce(` needs the declaration of rb.
        typeName = IMPLICIT_RECEIVERS[callee.receiver] ?? declaredType(text, callee.receiver) ?? callee.receiver
        if (this.resolveTypes(typeName, d.file).length === 0) typeName = null
      }
    }
    if (!methodName) return []

    let overloads: GraphMember[]
    if (typeName) {
      overloads = this.resolveTypes(typeName, d.file)
        .flatMap((t) => this.graph.membersOf(t))
        .filter((m) => m.name === methodName)
    } else {
      overloads = this.graph.membersNamed(methodName).filter((m) => m.name === methodName)
      // A bare method name is only useful while it points at a handful of types.
      if (new Set(overloads.map((m) => m.declaringType)).size > 4) return []
    }
    overloads = overloads.filter((m) => (m.kind === "method" || m.kind === "ctor") && m.obsolete === null)
    if (overloads.length === 0) return []

    const hints = [`Real overloads of ${methodName}:`]
    for (const member of overloads.slice(0, MAX_OVERLOADS)) hints.push(`  ${member.declaringType}: ${member.sig}`)
    if (overloads.length > MAX_OVERLOADS) hints.push(`  (+${overloads.length - MAX_OVERLOADS} more)`)
    return hints
  }
}

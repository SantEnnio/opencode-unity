// unity_lookup: forgiving API lookup for models that cannot be trusted to spell a name right.
// Every answer ends with the exact next call to make, because small models follow explicit
// pointers far better than they plan a navigation on their own.

import { similarity, suggestMembers } from "./enrich.ts"
import { type GraphMember, type GraphType, stripGenerics, type SymbolGraph } from "./graph/db.ts"

export type ExampleProvider = (apiPage: string) => string | null

const MAX_MEMBER_LINES = 40
const MAX_OVERLOADS = 10
const MAX_TYPES_FOR_MEMBER = 6

const KIND_ORDER = ["ctor", "property", "field", "method", "event", "enumvalue"]
const KIND_TITLES: Record<string, string> = {
  ctor: "Constructors",
  property: "Properties",
  field: "Fields",
  method: "Methods",
  event: "Events",
  enumvalue: "Values",
}

/** Runtime API first, editor API second, everything else last; shorter namespaces win ties. */
function typeRank(type: GraphType): number {
  const base = type.ns === "UnityEngine" ? 0 : type.ns.startsWith("UnityEngine") ? 1 : type.ns.startsWith("UnityEditor") ? 2 : 3
  return base * 100 + type.ns.length + (type.obsolete !== null ? 1000 : 0)
}

function tokens(query: string): string[] {
  return stripGenerics(query.replace(/\(.*$/, ""))
    .split(/[\s.:#/]+/)
    .filter(Boolean)
}

function typeHeader(type: GraphType, graph: SymbolGraph): string[] {
  const chain = graph.baseChain(type).slice(1)
  const lines = [`${type.kind} ${type.full}${chain.length > 0 ? ` : ${chain.map((t) => t.name).join(" : ")}` : ""}   (assembly ${type.asm})`]
  if (type.obsolete !== null) lines.push(`OBSOLETE: ${type.obsolete}${type.replacement ? ` Use ${type.replacement}.` : ""}`)
  if (type.summary) lines.push(type.summary)
  return lines
}

function renderType(type: GraphType, graph: SymbolGraph): string {
  const lines = typeHeader(type, graph)
  const members = graph.membersOf(type).filter((m) => m.obsolete === null)
  const own = members.filter((m) => m.declaringType === type.name)
  const inherited = members.length - own.length

  let budget = MAX_MEMBER_LINES
  for (const kind of KIND_ORDER) {
    const byName = new Map<string, GraphMember[]>()
    for (const m of own.filter((m) => m.kind === kind)) byName.set(m.name, [...(byName.get(m.name) ?? []), m])
    if (byName.size === 0 || budget <= 0) continue

    lines.push("", `${KIND_TITLES[kind]}:`)
    if (kind === "enumvalue") {
      lines.push(`  ${[...byName.keys()].join(", ")}`)
      continue
    }
    for (const overloads of byName.values()) {
      if (budget-- <= 0) {
        lines.push(`  ... (${byName.size} ${KIND_TITLES[kind]!.toLowerCase()} in total)`)
        break
      }
      lines.push(`  ${overloads[0]!.sig}${overloads.length > 1 ? `   (+${overloads.length - 1} overloads)` : ""}`)
    }
  }

  if (inherited > 0) {
    const bases = graph.baseChain(type).slice(1).map((t) => t.name)
    lines.push("", `Also inherits ${inherited} members from ${bases.join(", ")}.`)
  }
  lines.push("", `→ For one member with all overloads: unity_lookup("${type.name}.<member>")`)
  return lines.join("\n")
}

function renderMember(type: GraphType, name: string, members: GraphMember[], example: string | null): string {
  const lines = [`${type.full}.${name}`]
  const live = members.filter((m) => m.obsolete === null)
  const obsolete = members.filter((m) => m.obsolete !== null)

  for (const m of live.slice(0, MAX_OVERLOADS)) lines.push(`  ${m.sig}`)
  if (live.length > MAX_OVERLOADS) lines.push(`  (+${live.length - MAX_OVERLOADS} more overloads)`)
  for (const m of obsolete.slice(0, 3)) {
    lines.push(`  ${m.sig}`, `    OBSOLETE: ${m.obsolete}${m.replacement ? ` → use ${m.replacement}` : ""}`)
  }

  const summary = members.find((m) => m.summary)?.summary
  if (summary) lines.push("", summary)
  const declaring = members[0]!.declaringType
  if (declaring !== type.name) lines.push("", `Inherited from ${declaring}.`)
  if (example) lines.push("", "Example:", example)

  const replacement = live.length === 0 ? obsolete.find((m) => m.replacement)?.replacement : null
  if (replacement) lines.push("", `→ unity_lookup("${replacement.includes(".") ? replacement : `${type.name}.${replacement}`}")`)
  return lines.join("\n")
}

function fuzzyTypes(graph: SymbolGraph, wanted: string, limit: number): string[] {
  return graph
    .typeNames()
    .map((name) => ({ name, score: similarity(name, wanted) }))
    // Scores between 1.5 and 3 mean "shares a minority of its words": noise for a type search.
    .filter((c): c is { name: string; score: number } => c.score !== null && (c.score <= 1.5 || c.score >= 3))
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length)
    .slice(0, limit)
    .map((c) => c.name)
}

export function lookup(graph: SymbolGraph, query: string, example: ExampleProvider = () => null): string {
  const parts = tokens(query)
  if (parts.length === 0) return 'Give a type or member name, e.g. unity_lookup("Rigidbody.AddForce").'

  // Longest prefix that names a type: "UnityEngine.Rigidbody.AddForce", "Rigidbody AddForce", "rigidbody".
  for (let split = parts.length; split >= 1; split--) {
    const typeName = parts.slice(0, split).join(".")
    const types = graph
      .findTypes(typeName)
      .filter((t) => t.simple.toLowerCase() === parts[split - 1]!.toLowerCase())
      .sort((a, b) => typeRank(a) - typeRank(b))
    if (types.length === 0) continue

    const type = types[0]!
    const others = types.slice(1, 4).map((t) => t.full)
    const note = others.length > 0 ? `\n\n(Other types with this name: ${others.join(", ")})` : ""
    const memberName = parts[split]
    if (!memberName) return renderType(type, graph) + note

    const members = graph.membersOf(type)
    const exact = members.filter((m) => m.name.toLowerCase() === memberName.toLowerCase())
    if (exact.length > 0) {
      const name = exact[0]!.name
      return renderMember(type, name, exact, example(`${type.simple}.${name}`)) + note
    }

    const suggestions = suggestMembers(members, memberName)
    if (suggestions.length === 0) return `${type.full} has no member like '${memberName}'.\n\n→ unity_lookup("${type.name}") lists its members.`
    return [
      `${type.full} has no member '${memberName}'. Closest real members:`,
      ...suggestions.map((m) => `  ${m.sig}${m.obsolete !== null ? "  [OBSOLETE]" : ""}`),
      "",
      `→ unity_lookup("${type.name}.${suggestions[0]!.name}")`,
    ].join("\n")
  }

  // Not a type: maybe a bare member name ("AddForce").
  const wanted = parts[parts.length - 1]!
  const members = graph.membersNamed(wanted).filter((m) => m.obsolete === null && m.kind !== "ctor")
  if (members.length > 0) {
    const byType = new Map<string, GraphMember[]>()
    for (const m of members) byType.set(m.declaringType, [...(byType.get(m.declaringType) ?? []), m])
    const lines = [`'${wanted}' is a member of ${byType.size} type${byType.size === 1 ? "" : "s"}:`]
    const ordered = [...byType].sort(([a], [b]) => a.length - b.length)
    for (const [typeName, overloads] of ordered.slice(0, MAX_TYPES_FOR_MEMBER)) {
      lines.push(`  ${typeName}: ${overloads[0]!.sig}${overloads.length > 1 ? `   (+${overloads.length - 1} overloads)` : ""}`)
    }
    if (byType.size > MAX_TYPES_FOR_MEMBER) lines.push(`  ... and ${byType.size - MAX_TYPES_FOR_MEMBER} more types`)
    lines.push("", `→ unity_lookup("${ordered[0]![0]}.${members[0]!.name}")`)
    return lines.join("\n")
  }

  const candidates = fuzzyTypes(graph, wanted, 5)
  if (candidates.length === 0) {
    return `Nothing named '${query}' exists in this Unity version or in the installed packages. Do not use it.\n\n→ unity_docs_search("${query}") searches the manual instead.`
  }
  return [`No exact match for '${query}'. Closest types:`, ...candidates.map((c) => `  ${c}`), "", `→ unity_lookup("${candidates[0]}")`].join("\n")
}

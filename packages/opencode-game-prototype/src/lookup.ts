// What a three.js class really has, read from the shipped build itself: the module is imported
// once, each class is constructed when it can be, and its fields and methods are listed. No
// documentation to download, nothing that can drift from the version the prototypes run.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { instead } from "./api.ts"

type Members = { fields: string[]; methods: string[]; constructable: boolean }

const SKIP = new Set(["constructor", "toJSON", "clone", "copy"])

/**
 * For a class that cannot be constructed here (WebGLRenderer needs a document): its members as
 * the source assigns them, `this.setSize = function` and `this.domElement = ...`.
 */
function sourceMembers(source: string, className: string): Members {
  const start = source.search(new RegExp(`^class ${className}\\b`, "m"))
  if (start < 0) return { fields: [], methods: [], constructable: false }
  const next = source.slice(start + 1).search(/^class \w/m)
  const body = source.slice(start, next < 0 ? undefined : start + 1 + next)
  const fields = new Set<string>()
  const methods = new Set<string>()
  for (const match of body.matchAll(/\bthis\.(\w+)\s*=\s*(function\b|\(|async\b)?/g)) {
    if (match[1]!.startsWith("_")) continue
    if (match[2]) methods.add(match[1]!)
    else if (!methods.has(match[1]!)) fields.add(match[1]!)
  }
  for (const match of body.matchAll(/^\t(\w+)\s*\([^)]*\)\s*\{/gm)) if (!match[1]!.startsWith("_") && match[1] !== "constructor") methods.add(match[1]!)
  return { fields: [...fields].filter((f) => !methods.has(f)), methods: [...methods].sort(), constructable: false }
}

function membersOf(Class: Function): Members {
  const fields = new Set<string>()
  let constructable = true
  // Constructing a deprecated class makes three.js warn on the console; this is not the page.
  const warn = console.warn
  console.warn = () => {}
  try {
    for (const key of Object.keys(new (Class as new () => object)())) if (!key.startsWith("_") && !key.startsWith("is")) fields.add(key)
  } catch {
    constructable = false
  } finally {
    console.warn = warn
  }
  const methods = new Set<string>()
  const accessors = new Set<string>()
  for (let proto = Class.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (key.startsWith("_") || SKIP.has(key)) continue
      if (typeof descriptor.value === "function") methods.add(key)
      else if (descriptor.get || descriptor.set) accessors.add(key)
    }
  }
  for (const key of accessors) fields.add(key)
  return { fields: [...fields], methods: [...methods].sort(), constructable }
}

export type Lookup = (query: string) => Promise<string>

/** A lookup over the three.js build in `dir`; the module is loaded on the first call. */
export function createLookup(dir: string, revision: string): Lookup {
  let loaded: Promise<Record<string, unknown>> | null = null
  const load = () => (loaded ??= import(pathToFileURL(path.join(dir, "three.module.js")).href) as Promise<Record<string, unknown>>)
  let source: string | null = null
  const sources = () => (source ??= ["three.module.js", "three.core.js"].map((file) => fs.readFileSync(path.join(dir, file), "utf8")).join("\n"))

  return async (query: string) => {
    const THREE = await load()
    const exports = new Set(Object.keys(THREE))
    const [rawClass = "", rawMember] = query.trim().replace(/^THREE\./i, "").replace(/\(.*$/, "").split(/[.#:\s]+/, 2)
    const className = [...exports].find((name) => name.toLowerCase() === rawClass.toLowerCase()) ?? null
    if (!className) return `[proto] three.js ${revision} has no THREE.${rawClass}: ${instead(rawClass, exports)}.`
    const value = THREE[className]
    if (typeof value === "object" && value !== null) {
      const keys = Object.keys(value).filter((k) => !k.startsWith("_"))
      const functions = keys.filter((k) => typeof (value as Record<string, unknown>)[k] === "function")
      const others = keys.filter((k) => !functions.includes(k))
      if (rawMember) {
        const member = keys.find((k) => k.toLowerCase() === rawMember.toLowerCase())
        return member ? `[proto] THREE.${className}.${member} exists.` : `[proto] THREE.${className} has no ${rawMember}. It has: ${keys.slice(0, 30).join(", ")}.`
      }
      return [`[proto] THREE.${className} in three.js ${revision}:`, functions.length > 0 ? `functions: ${functions.join(", ")}` : "", others.length > 0 ? `values: ${others.join(", ")}` : ""].filter(Boolean).join("\n")
    }
    if (typeof value !== "function") return `[proto] THREE.${className} is a constant (${typeof value}), not a class.`
    let members = membersOf(value)
    if (!members.constructable) {
      const fromSource = sourceMembers(sources(), className)
      members = { fields: [...new Set([...members.fields, ...fromSource.fields])], methods: [...new Set([...members.methods, ...fromSource.methods])].sort(), constructable: false }
    }
    const all = [...members.fields, ...members.methods]

    if (rawMember) {
      const member = all.find((name) => name.toLowerCase() === rawMember.toLowerCase())
      if (member) return `[proto] THREE.${className}.${member} exists: a ${members.methods.includes(member) ? "method" : "field"} of ${className}.`
      const close = all.filter((name) => name.toLowerCase().includes(rawMember.toLowerCase()) || rawMember.toLowerCase().includes(name.toLowerCase())).slice(0, 5)
      return `[proto] THREE.${className} has no ${rawMember}.${close.length > 0 ? ` Closest: ${close.join(", ")}.` : ` Its methods: ${members.methods.slice(0, 25).join(", ")}.`}`
    }

    const lines = [`[proto] THREE.${className} in three.js ${revision}:`]
    if (members.fields.length > 0) lines.push(`fields: ${members.fields.slice(0, 40).join(", ")}${members.fields.length > 40 ? ", ..." : ""}`)
    else if (!members.constructable) lines.push("fields: not listed (the class needs arguments to be constructed)")
    if (members.methods.length > 0) lines.push(`methods: ${members.methods.slice(0, 60).join(", ")}${members.methods.length > 60 ? ", ..." : ""}`)
    return lines.join("\n")
  }
}

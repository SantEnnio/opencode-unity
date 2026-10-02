// The names three.js really exports, read from the build shipped with the plugin. A small model
// writes names from older versions or from other engines: each one is answered with the name that
// exists, attached to the error it is already reading.

import fs from "node:fs"
import path from "node:path"

const cache = new Map<string, Set<string>>()

/** Every name `import * as THREE from "three"` provides. */
export function threeExports(dir: string): Set<string> {
  const cached = cache.get(dir)
  if (cached) return cached
  const names = new Set<string>()
  let source = ""
  try {
    source = fs.readFileSync(path.join(dir, "three.module.js"), "utf8")
  } catch {
    // no build: no names, and no name is reported as unknown
  }
  for (const block of source.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const item of block[1]!.split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop()
      if (name) names.add(name)
    }
  }
  cache.set(dir, names)
  return names
}

// Removed or renamed in three.js over the years, and still what a model writes first.
const RENAMED: Record<string, string> = {
  Geometry: "BufferGeometry",
  CubeGeometry: "BoxGeometry",
  Face3: "BufferGeometry (faces are gone: geometries are arrays of numbers now)",
  sRGBEncoding: "SRGBColorSpace",
  LinearEncoding: "LinearSRGBColorSpace",
  Math: "MathUtils",
  ImageUtils: "TextureLoader",
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]!
}

/** What to write instead of a name three.js does not have. */
export function instead(name: string, exports: Set<string>): string {
  const known = RENAMED[name]
  if (known && exports.has(known.split(" ")[0]!)) return `use THREE.${known}`
  // BoxBufferGeometry and its family lost the "Buffer" years ago.
  const plain = name.replace(/BufferGeometry$/, "Geometry")
  if (plain !== name && exports.has(plain)) return `use THREE.${plain}`
  const lower = name.toLowerCase()
  const close = [...exports]
    .map((candidate) => ({ candidate, score: candidate.toLowerCase() === lower ? -1 : candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase()) ? 1 : distance(lower, candidate.toLowerCase()) }))
    .filter((c) => c.score <= Math.max(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length)
    .slice(0, 3)
    .map((c) => `THREE.${c.candidate}`)
  return close.length > 0 ? `the closest names are ${close.join(", ")}` : "it is not part of three.js"
}

/** `THREE.Something` in a source file where three.js has no `Something`. One entry per name. */
export function unknownNames(source: string, exports: Set<string>): { name: string; line: number }[] {
  if (exports.size === 0) return []
  const found = new Map<string, number>()
  source.split(/\r?\n/).forEach((text, index) => {
    if (/^\s*(\/\/|\*)/.test(text)) return
    for (const match of text.matchAll(/\bTHREE\.([A-Za-z_$][\w$]*)/g)) {
      const name = match[1]!
      if (!exports.has(name) && !found.has(name)) found.set(name, index + 1)
    }
  })
  return [...found].map(([name, line]) => ({ name, line }))
}

/** The fix for an error message the browser gave, when the plugin knows one. */
export function fixFor(text: string, exports: Set<string>): string | null {
  const missing = /THREE\.([A-Za-z_$][\w$]*) is not a (?:constructor|function)/.exec(text) ?? /does not provide an export named '([\w$]+)'/.exec(text)
  if (missing && exports.size > 0 && !exports.has(missing[1]!)) return `three.js has no ${missing[1]}: ${instead(missing[1]!, exports)}.`
  const specifier = /Failed to resolve module specifier ["']([^"']+)["']/.exec(text)
  if (specifier) return `"${specifier[1]}" cannot be imported. Only "three", "kit" and your own files ("./name.js") can.`
  if (/require is not defined/.test(text)) return 'use import, not require(): import * as THREE from "three".'
  return null
}

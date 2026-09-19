import path from "node:path"

const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch"])

/** Paths a file-editing tool call is about to touch (or has touched). */
export function writtenPaths(toolName: string, args: unknown, directory: string): string[] {
  if (!WRITE_TOOLS.has(toolName) || typeof args !== "object" || args === null) return []
  const record = args as Record<string, unknown>
  const paths: string[] = []
  if (typeof record.filePath === "string") paths.push(record.filePath)
  if (typeof record.patchText === "string") {
    for (const match of record.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
      paths.push(match[1]!.trim())
    }
  }
  return paths.map((p) => path.resolve(directory, p))
}

import { decodeEntities } from "../docs/html.ts"

export type TestFailure = { name: string; message: string; stack: string }
export type TestSummary = { total: number; passed: number; failed: number; skipped: number; failures: TestFailure[] }

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null
const inner = (xml: string, tag: string) => {
  const body = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`).exec(xml)
  return body ? (body[1] ?? decodeEntities(body[2] ?? "")).trim() : ""
}

/** Reads an NUnit 3 results file (what Unity's test runner writes): totals plus the failed leaf tests. */
export function parseNUnit(xml: string): TestSummary {
  const run = /<test-run\b[^>]*>/.exec(xml)?.[0] ?? ""
  const number = (name: string) => Number(attr(run, name) ?? 0)
  const failures: TestFailure[] = []
  for (const match of xml.matchAll(/<test-case\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-case>)/g)) {
    if (attr(match[1]!, "result") !== "Failed") continue
    const body = match[2] ?? ""
    failures.push({
      name: decodeEntities(attr(match[1]!, "fullname") ?? attr(match[1]!, "name") ?? "?"),
      message: inner(body, "message"),
      stack: inner(body, "stack-trace").split("\n").slice(0, 4).join("\n"),
    })
  }
  return { total: number("total"), passed: number("passed"), failed: number("failed"), skipped: number("skipped") + number("inconclusive"), failures }
}

export function renderTests(summary: TestSummary, maxFailures = 10): string {
  const head = `[unity] Tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.total} total).`
  if (summary.total === 0) return `${head}\nNo tests were found. Tests live in an assembly with a .asmdef that references UnityEngine.TestRunner and nunit.framework.`
  if (summary.failures.length === 0) return head
  const lines = [head, ""]
  summary.failures.slice(0, maxFailures).forEach((f, i) => {
    lines.push(`${i + 1}) ${f.name}`, ...f.message.split("\n").slice(0, 6).map((l) => `   ${l}`))
    if (f.stack) lines.push(...f.stack.split("\n").map((l) => `   ${l.trim()}`))
  })
  if (summary.failures.length > maxFailures) lines.push(`(+${summary.failures.length - maxFailures} more failures)`)
  return lines.join("\n")
}

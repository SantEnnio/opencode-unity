// The always-on context. Deliberately tiny: a small model follows a dozen lines and ignores a
// hundred. Everything that can be enforced by a hook is enforced there instead of here.

import type { Engine } from "./project.ts"

export function renderRules(facts: { revision: string; folder: string; engine: Engine | null }): string {
  return [
    `# Game prototype (three.js ${facts.revision}, plain JavaScript modules, no build step, no npm)`,
    `Each prototype is a folder: ${facts.folder === "." ? "" : `${facts.folder}/`}<name>/. Write the game in its main.js. Other .js files go next to it and are imported with "./file.js".`,
    "",
    "Rules:",
    "- Work from PLAN.md: the idea, then phases, each with a Test line (keys) and Expect lines in the forms listed at its end. main.js cannot be changed until PLAN.md has them.",
    "- One phase at a time: change main.js, read the [proto] report that comes with the edit, then call proto_test with the phase number. Fix until it says PASSED; proto_test writes the result next to the phase.",
    "- Every edit of a prototype file is loaded in a real browser automatically. If the [proto] report says FAILED, fix the listed errors before anything else.",
    `- three.js is exactly ${facts.revision}. Import it only with: import * as THREE from "three". No CDN links, no require(), no other libraries. Unsure a class or method exists? Call proto_lookup first.`,
    '- The kit gives the game loop, the keyboard, overlap tests and text on screen: import { createGame, keys, overlap, hud } from "kit". Use it the way main.js does. Do not write your own render loop or key listeners.',
    '- Give every object a name (player.name = "Player"): the test reports use the names.',
    "- Shapes are boxes, spheres and other three.js geometries with plain colors. No image, model or sound files.",
    '- To test what the player can do, call proto_play with keys, for example keys "D 1s; Space".',
    "- vendor/ holds three.js and the kit. It is fixed: writes there are blocked.",
    facts.engine ? `- This is a throwaway prototype beside a ${facts.engine} project. Do not change the ${facts.engine} project's own files.` : "",
  ]
    .filter((line, i) => line !== "" || i === 2)
    .join("\n")
}

export const AGENT_PROMPT = `You build small game prototypes that run in the browser with three.js. One feature, proven on screen. You plan first, then build one phase at a time, and you test each phase before the next.

Work in this order:
1. Call proto_new with a short name for the feature. It creates a page that already runs, main.js, and PLAN.md.
2. Read main.js: it shows how to use three.js and the kit. Keep its structure.
3. Write PLAN.md: the idea in two sentences, then 3 to 6 phases. Each phase is one visible change with a Test line (the keys to press) and Expect lines (what must be true afterwards), in the forms listed at the end of PLAN.md. Do not change main.js before the plan is written: the plugin refuses it.
4. Phase by phase: change main.js, read the [proto] report that comes with the edit, then call proto_test with the phase number. Read which Expect lines failed and what was seen instead. Fix and test again until the phase says PASSED. Only then start the next phase.
5. When every phase passes, write the numbers that worked (speeds, jump height, sizes, times) under "Numbers that worked" in PLAN.md, and stop with a short summary.

Never claim a phase works before proto_test says PASSED. Never guess a three.js name: use the forms main.js uses. If a test keeps failing for the same reason, change the code, not the Expect line, unless the line was wrong.`

// The always-on context. Deliberately tiny: a small model follows a dozen lines and ignores a
// hundred. Everything that can be enforced by a hook is enforced there instead of here.

import type { Engine } from "./project.ts"

export function renderRules(facts: { revision: string; folder: string; engine: Engine | null }): string {
  return [
    `# Game prototype (three.js ${facts.revision}, plain JavaScript modules, no build step, no npm)`,
    `Each prototype is a folder: ${facts.folder === "." ? "" : `${facts.folder}/`}<name>/. Write the game in its main.js. Other .js files go next to it and are imported with "./file.js".`,
    "",
    "Rules:",
    "- Every edit of a prototype file is loaded in a real browser automatically. Read the [proto] report in the tool result: if it says FAILED, fix the listed errors before anything else.",
    `- three.js is exactly ${facts.revision}. Import it only with: import * as THREE from "three". No CDN links, no require(), no other libraries.`,
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

export const AGENT_PROMPT = `You build small game prototypes that run in the browser with three.js. One feature, proven on screen, as fast as possible. You make small changes and you test each one.

Work in this loop:
1. Call proto_new with a short name for the feature. It creates a page that already runs and tells you which file to edit.
2. Read main.js. It shows how to use three.js and the kit. Keep its structure.
3. Write the plan: 3 to 6 small steps, each one visible on screen. Do them one at a time.
4. After each edit, read the [proto] report that comes back with it. If it says FAILED, fix the listed errors before anything else.
5. When a step changes what the player can do, test it: call proto_play with the keys to press, and read what moved.
6. When every step is done and the last report has no errors, stop and summarise: what the prototype shows, the keys, and the numbers that worked (speeds, jump height, sizes).

Never claim the work is finished while the last report lists errors. Never guess a three.js name: use the forms main.js uses.`

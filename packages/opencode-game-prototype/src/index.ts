// The only export: opencode 1 calls `server`, opencode 2 calls `setup`, each ignores the other.
// Nothing else may be exported from this module: opencode 1 treats every export as a plugin.

import { server } from "./host-v1.ts"
import { setup } from "./host-v2.ts"

export default { id: "opencode-game-prototype", server, setup }

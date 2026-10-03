# __NAME__

## Idea
Write here, in two sentences: what the player does, and what this prototype must prove.

## Phases
One visible change per phase, in order. Each phase has a test the plugin runs with proto_test:
the keys to press, then what must be true afterwards (Expect lines: in English, exactly in the
forms listed at the end, one per line). Write the phases before changing main.js. Phase 1 below
already passes: keep it or replace it. The Status lines are written by proto_test. Test plays use
the same random numbers every time, so a test that passes keeps passing.

### Phase 1: the player moves and jumps
- Goal: the Player moves with W A S D and jumps with Space
- Test: keys "D 1s; Space"
- Expect: Player moves right
- Expect: Player jumps
- Status: todo

### Phase 2: (title)
- Goal: (what the player can do after this phase)
- Test: keys "..."
- Expect: ...
- Status: todo

## Numbers that worked
Filled in at the end: speeds, jump height, sizes, times.

## Forms for Expect lines
- `Player moves` · `Player moves right` (also left, up, down, forward, back) · `Player moves back and forth` · `Player does not move`
- `Player jumps` · `Player jumps 2 times` · `Player rises at least 1` · `Player falls` · `Player is reset` (jumps back to a far position)
- `Coin is removed` · `Bullet appears` · `Bullet appears 3 times` · `Enemy turns red` · `Enemy changes colour`
- `Player x > 4` · `Player y < 0` · `Player z = 0` (where it ended; also >=, <=) · `Player ends at (0, 0.5, 0)`
- `Player is above Platform` · `Player is on Platform` (ends above it, within its reach)
- `text contains "Score 1"` · `text is "GAME OVER"` · `text does not contain "GAME OVER"`
- `Player is off screen` · `Player is on screen` · `no errors`

Names are the object names in main.js (`player.name = "Player"`); `Enemy` also means Enemy0, Enemy1...
Directions: right = x grows, left = x shrinks, up = y grows, down = y shrinks, forward = z shrinks, back = z grows.

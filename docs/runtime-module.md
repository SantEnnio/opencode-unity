# Observing a running game

Design for the runtime module: letting the model learn what a game does while it plays, without
spending the context the task needs. Nothing here is built yet. Everything in "What the Editor
actually does" was measured on 2026-09-20 against `sandbox/PipelineProbe` (macOS, Unity 6000.0.71f1,
`com.unity.pipeline` 0.7.0-exp.1); the rest follows from those measurements and from
[small-model-tool-design.md](small-model-tool-design.md).

## The problem

After a scene is built and the scripts compile, every remaining question is about behaviour: does
the player move, does it fall through the floor, does something throw every frame. Today the only
answer is `unity_console`, which returns `tail: 50`. That is truncation, and truncation is the
trap: it spends context anyway and never tells the model what it missed.

A stream cannot be given to a model whose whole context is small. So the module's one invariant is:

> **Every runtime answer is a fixed number of lines, whatever happened and however long the game
> ran.** The reduction happens inside Unity or inside the plugin. The raw buffer never crosses.

Not truncation. Reduction.

## What the Editor actually does

| Question | Measured answer |
|---|---|
| Can the agent start and stop play? | Yes. `editor_play` / `editor_stop` / `editor_status`, which reports `playMode: playing\|stopped` |
| Does the game run while Unity is unfocused? | **No, unless Interaction Mode is NoThrottling.** A falling Rigidbody stayed frozen 2.8 s. See below |
| Are property reads live during play? | Yes for `Transform`: a cube read 12 → 0.5 as it fell |
| Is the simulation real-time? | Yes: 11.5 m of free fall took 1.6 s against 1.53 s theoretical |
| Cost of the first call after `editor_play` | **~6.6 s** — entering play reloads the domain and drops the HTTP listener. `pipelineExec`'s retry already rides it out |
| Cost of a read once running | ~65 ms; a `batch` of 3 objects ~190 ms |
| Runtime velocity of a Rigidbody | **Not available.** `get_component_properties` returns serialized fields (`m_Mass`, `m_Drag`); derive velocity from position deltas |
| Scene edits during play | Refused: *"This cannot be used during play mode."* The data-loss risk is handled by the package, not by us |
| Console during play | Works |
| Frame timing | `get_performance_stats` → `frameTiming.cpuFrameTimeMs`, `gpuFrameTimeMs`, `cpuMainThreadFrameTimeMs` |
| `wait_for` as a server-side watch | **Unusable as found.** With `target` + a dotted member it never saw the value change; with `findType` it bound to an arbitrary instance out of 5 |

### Interaction Mode

The throttle is a global EditorPrefs int, `"InteractionMode"`
(`UnityEditor.PreferencesProvider+InteractionMode`: `0 Default, 1 NoThrottling, 2
MonitorRefreshRate, 3 Custom`). Setting it to `1` through `eval` takes effect immediately, with no
apply call, and the game then runs unfocused at correct real time.

Two conditions on using it, both non-negotiable:

- It is a **user preference global to the Unity installation**, not to the project. Ask once, set
  it for the run, restore the previous value afterwards — including when the run is aborted.
- NoThrottling pegs a CPU core. It goes on for the duration of the run and off after.

## The design

### Two paths, and the cheap one is the main one

**The user plays.** The model calls nothing. The plugin notices play ended and attaches the report
to whatever the model reads next, exactly as the compile report is attached after a `.cs` edit. The
machinery exists (`compileOnEdit`, the idle gate). **Cost: zero tools.** This path is immune to the
focus problem, because a user who is playing has focus.

**The agent plays.** One tool, `unity_play()`, no arguments, synchronous: guard, set Interaction
Mode, `editor_play`, sample for a few seconds, `editor_stop`, restore Interaction Mode, return the
report.

No `start`/`stop`/`report` actions, no duration argument, no state. A small model does not remember
that it is in play mode, and *"every optional parameter will be filled in sooner or later"*. One
call, one answer, and it cannot forget to stop.

A few seconds is enough and not a compromise: with nobody pressing keys, a game reaches its steady
state almost at once. Which fixes the module's scope — **`unity_play` tests what happens with no
input**: gravity, spawning, initialisation, a NullReference in `Start`/`Update`. Testing the
controls stays with the user, and that is what the zero-tool path is for.

### The guard that cannot be skipped

Before the report says anything about behaviour, it must **prove time advanced** — compare
`Time.frameCount` between the first and last sample. If frames did not advance, the answer is
"the game did not run, bring the Unity window to the front", never a diagnosis.

Without this, a throttled Editor produces *"/Player never moved"* and sends the model to fix a bug
that does not exist. That is worse than having no module: a wrong answer costs a whole session.

### The report

The conclusion goes first. A small model does not synthesise: give it data and expect the verdict
and the verdict never comes.

```
Play 6.0 s, 358 frames. /Player never moved.
NullReferenceException in PlayerController.Update, 360 times, first at 0.1 s
/Player: still at (0,1,0). Rigidbody present, position never changed
→ read the exception with unity_console, then fix PlayerController.cs
```

Four lines for a run of any length. The ranking that fills them:

1. **Exceptions**, collapsed by signature (type + top frame), with first timestamp and count.
2. **Anomalies on observed objects** — threshold crossings, not values: fell below the lowest
   collider, went NaN, was destroyed, **never moved at all**.
3. **Baseline**, one line per observed object: start → end.

The second category is what justifies the module. *"Never moved"* is an absence, and no amount of
log tailing ever shows an absence. It is also the most common question a small model has about a
game it just built.

What counts as an observed object is not declared: the plugin already knows what the model created
and modified this session.

### Guards on starting

- Refuse if the scene is dirty — *"save first with unity_scene_save"*.
- Refuse if the last compile failed. Playing a red build answers nothing.
- Refuse, without taking control, if play was started by the user.
- Restore Interaction Mode on every exit path, including abort.

## What v1 leaves out, and why

**Collisions** and **declared watches**. Both were in the first sketch; both are deferred.

With a four-line budget collisions would almost never make the cut, and capturing them globally
needs either Unity 6's `Physics.ContactEvent` or a component on every observed object — a C# package
to ship and install, for something that has not yet been shown to be missing. A declared watch
assumes the model knows what to ask before it has seen anything, which at this size is rarely true,
and `wait_for` — the primitive that would have made it cheap — does not work as found.

This follows the method that produced everything else here: *"everything in this document was
learned by reading real sessions back, not by guessing."* Ship the smallest thing, read the
sessions, add only what is actually missing.

## To settle before building

1. **The report must be seen by a small model before it is trusted.** Read the session back
   (`~/.local/share/opencode/opencode.db`) and check the verdict line is acted on, not ignored.
2. Whether the plugin can detect "the user stopped playing" cheaply enough to push the report
   without polling the Editor.
3. Whether Interaction Mode behaves the same on Windows and Linux. Everything here is macOS.
4. `wait_for`: worth one more look. A working server-side watch would remove the sampling loop.

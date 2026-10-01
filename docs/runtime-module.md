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

## Revision 2026-09-30: an optional probe package

Reported from a real prototype: the model builds and fixes fine, but **the Console is not enough
to understand what the game does**. That is the evidence the section above was waiting for, so
the in-project code it deferred comes back, as an **optional** package with its own install
command. The invariant does not change: every answer is a fixed number of lines.

### What the Console cannot say

The Console is a log of what the code chose to print. It cannot show an absence (*"never moved"*,
*"never collided"*, *"the jump action never fired"*), state over time (where the car was at 3 s),
physics (velocity, contacts), or which input actually reached the game. The Pipeline package
alone cannot either: it reads serialized fields from outside, about 65 ms each, with no velocity
and no input.

### The package

- `com.opencode-unity.probe`, in this repository, versioned with the plugin and shipped inside
  its assets like the symbol exporter.
- Installed as an **embedded package**: copied into `<project>/Packages/com.opencode-unity.probe/`.
  Not a git URL: Unity resolves git dependencies only when git is installed, and classroom
  machines may not have it. It works offline and always matches the plugin version.
- Editor only (`#if UNITY_EDITOR` assembly): nothing reaches a build. Active only in Play mode.
  It adds no component to any object and changes no scene or prefab: it hooks itself up when
  Play starts.
- Install and update: the `unity_probe_install` tool (with consent, like the Pipeline package),
  or `opencode-unity probe install <project>` from the CLI. `/unity` shows whether it is missing,
  installed or out of date, and what is lost without it. Removal: delete the folder.

### What it records, reduced inside Unity

- **Exceptions and log errors**, collapsed by signature, with count and first time.
- **Tracked objects**, sampled at about 10 Hz: position, velocity from the Rigidbody, active
  state. Tracked means what the model created or changed this session (the plugin writes the list
  to `Library/OpencodeUnity/probe/watch.json`), plus objects with a Rigidbody or a
  CharacterController, capped at about a dozen. Reduced to segments and anomalies: *moved 0 → 12 m
  along +z, then stopped*, *fell below the lowest collider*, *never moved*, *went NaN*, *destroyed*.
- **Collisions and triggers**, aggregated per pair (Unity 6 contact events), first time and count.
- **Input**: which Input System actions were performed, and when. This answers *"I pressed W and
  nothing happened"* directly.
- **Frames and time**, to prove the game ran before saying anything about behaviour.

On stop it writes `Library/OpencodeUnity/probe/last-run.json`: a summary and a per-object detail.
The file is the transport: it does not depend on the Pipeline package, and it works when the user
is the one playing.

### How it reaches the model

1. **The user plays, the model calls nothing.** After play stops, the summary goes with the
   user's next message. *"The car doesn't move"* arrives together with *"Play 8 s. W held 5 s,
   action Move performed 0 times. /PlayerCar moved 0 m"*. Under the context budget rules below.
2. **`unity_play` with a `path`**: that object's timeline from the last run, fixed size. The same
   tool as 3, so the probe adds one tool, not two.
3. **The agent plays: `unity_play`.** The plugin writes a request file and starts play; the probe
   runs the input script, stops play by itself after a few seconds and writes the report. Play,
   timing and stop all happen inside Unity, so the ~6.6 s domain reload on entering play does not
   matter. The probe also sets Interaction Mode to NoThrottling for the run and restores it on
   every exit path, from inside Unity.
4. **Simulated input**, with the Input System: `unity_play` takes one optional flat text argument,
   `keys: "W 2s; Space; W+D 1s"`, played on a virtual keyboard the probe adds for the run.

### The context budget

The whole context is small, so the automatic summary follows five rules:

- **Ephemeral.** It is added to the request in opencode 2's `context` hook, just before dispatch,
  and never stored in the session. Attaching it to the stored message (`prompt` hook) would make
  every past run cost tokens on every later turn.
- **At the end.** It goes after the last user message of the request, never in the system prompt.
  llama.cpp reuses its prompt cache only while the start of the request is unchanged: text that
  changes near the top makes it reprocess the whole context, about 40 s for 30K tokens at the
  ~700 t/s measured on an RTX 3060.
- **Replaced.** Only the latest run, never a list. It is dropped after two turns or at the next run.
- **Capped.** One verdict line, at most three findings, one pointer: about five lines, under 100
  tokens, whatever happened.
- **Only when it says something.** A run with no exception, no anomaly and no input without effect
  is one line: `Last play 12 s: no errors, nothing unusual. Details: unity_play with a path.`

Tools cost context too (19 tools are ~2,500 tokens already): the probe's tool is registered only
when the probe is installed, and `unity_probe_install` only while it is not.

### Order of work

1. The package, the install command, `last-run.json`, path 1 under the budget rules, and
   `unity_play` reading the last run (with a `path`).
2. `unity_play` starting a run itself, without input.
3. `keys`.

Each step ships only after a small model has been seen using it in a real session, read back from
the session database.

### Step 1, built (2026-09-30)

Package, install (tool, CLI, and inside all three plugin installs), `last-run.json`, the play note,
and `unity_play` reading the last run. Checked live in `sandbox/PipelineProbe` (Unity 6000.0.71f1,
Input System 1.11.2) and opencode 2.0.20:

- A cube falling 4.5 m: 1.0 s of fall, then still, one contact with the floor at 0.96 s, which is
  free fall. Recorded at 10 Hz, the report is four lines.
- An exception in `Update` **stopped the game after 1 s**: the Console's Error Pause. Without a
  pause record the report said "Last play 1.0 s" after seven seconds of Play, which reads as a
  game that barely ran. The probe now records pauses, and the note says why the game stopped.
- Keys already down when Play starts are not player input (the shortcut that started Play, stale
  state): the first frames, and time with Unity in the background, are ignored.
- The note reached the model, which explained the exception and the pause without calling a
  tool, and the session database had no trace of it. The plugin's own opencode 2 documentation
  says the same: context hook changes "affect only the outgoing model call, not persisted history".
- Four contact API members changed name in Unity 6 (`ContactPair.collider`...): the probe uses the
  new ones, or the API Updater rewrites the DLL on every import.

### Step 2, built (2026-09-30)

`unity_play` with `new_run: true`. The plugin writes `probe/request.json`; the probe, polling
every 0.5 s from the Editor update, enters Play itself, sets Interaction Mode to NoThrottling (the
previous value kept in an EditorPref, restored on EnteredEditMode and on the next load after a
crash), and stops Play after 5 s of real time from the Editor update, which keeps running while
the game is paused. With the Pipeline package connected, the plugin also sends `editor_play`.

Measured: 7.9-9.0 s per call, of which 4.9 s of game, with a second Editor holding the Pipeline
port, so through the request file alone. The recording is marked `startedBy: agent` and never
becomes a play note: it is already the tool's result.

Found on the way: with two Editors open, both claim the Pipeline port and the plugin can reach the
wrong one. Checked with a read-only call: an Editor answers another Editor's token with 401
Unauthorized, so nothing is executed there.

Choices: `unity_play` without arguments still reads the last play, because the play note points
there and a model calling it after the user played must not replace the user's recording.
Starting a run takes `new_run: true`.

### Step 3, built (2026-09-30)

`unity_play` with `keys`, a plain-text script: `"W 2s; Space; W+D 1s; wait 1s"`. The plugin parses
it forgivingly (`shift+w for 2 seconds`, `up 500ms`) into Input System `Key` names and refuses
unknown keys with the list of valid ones and an example. The run lasts the script plus 2 s, at
least 5 s, at most 30 s.

The probe adds a virtual `Keyboard` for the run, makes it `Keyboard.current`, queues its state
from the player loop, and removes it afterwards. Two Editor behaviours would have dropped the keys
with Unity in the background: the keyboard goes to the game only while the Game view has focus,
and devices are disabled when the application loses focus. The probe swaps `InputSystem.settings`
for a copy with `AllDeviceInputAlwaysGoesToGameView` and `IgnoreFocus` for the run and puts the
original back: the project's settings asset is never changed.

Measured with a test scene built at Play: `W 2s; Space` moved a cube driven by Input Actions 7.3 m
and it jumped to y 1.7, and moved a cube reading `Keyboard.current` directly 5.8 m. Recorded:
W held 2.0 s, Space once, actions Move and Jump once each. 9.4 s for the call. The timeline now
gives the highest point of a movement, since a jump starts and ends at the same height.

Not covered: the mouse and gamepads, and the old Input Manager, which cannot be driven: the plugin
says so and offers a run without keys.

Added the same night, after trying it with qwen3.6-35b-a3b:

- **The test runs the code the model just wrote.** An Editor in the background does not import
  changed scripts, so a test play would have run the old code. The probe calls
  `AssetDatabase.Refresh()` once per request and waits for the compile before entering Play.
  Checked: a speed changed from 3 to 6 behind Unity's back took the cube from 5.8 m to 12.9 m.
- **A red build answers at once.** Unity refuses Play while scripts do not compile; the probe
  refuses the request (`refused.json`, reason `compile`) and the plugin says so in 2.3 s instead of
  waiting two minutes.
- qwen, asked in plain words to check that W moves and Space jumps, called `unity_play` with
  `keys: "W 2s; Space; W+Space 1s"` on its own and reported both working, in about two minutes.
- qwen, told only that Space does not make the cube jump, found the Jump action bound to J, fixed
  it in one edit, and checked with `keys: "Space 1s"` and the cube's timeline: 78 s in all. It
  read the two-Editors message correctly the first time.
- **Two report fixes from that session.** "Never moved while keys were held" was said of a second
  player that the key does not drive: which object the keys should move is unknown, so the finding
  is now only "keys were held and nothing moved". And a jump in place read "stayed at": it now reads
  "went up to y 1.7 and came back".
- **An error in the first frame read as "the game did not run".** Awake and Start run before
  EnteredPlayMode reaches the probe; an exception there pauses the game at once (Error Pause), and
  the recording had 0 frames, no log, no pause. The probe now catches logs from the moment the
  scripts load for Play and checks for a pause when it starts; the report counts errors and pauses
  as a game that ran. It also points at the first stack frame in the project's own code
  (`BallLauncher.Start () (Assets/Scripts/BallTest.cs:20)`), not at Unity's.
- **What still works has to be said.** With another project's Editor on the Pipeline port, qwen,
  asked why a ball hangs in the air, read "the scene tools, the Console and tests do not work" and
  stopped to ask the user, after one call. The message now names what still works (scripts, and
  `unity_play new_run true`, which does not need the port) and ends with "tell the user, then
  carry on". The same request then took 88 s: it found the missing Rigidbody, added it, and
  checked with a test play that the ball falls from y 4.0 to the floor.

### Still open

- Sampling rate and the object cap: measure the cost in a real scene.
- Interaction Mode, and play started from a tool, on Windows.
- Check that opencode 2's `context` hook really stores nothing: read the session database back
  after a turn.
- Measure the prompt cache on the RTX 3060: prompt processing time with the summary at the end,
  at the top, and absent.
- opencode 1: whether `experimental.chat.messages.transform` can do the same. If not, opencode 1
  gets the tool only.
- A virtual keyboard next to a real one: answered, both. Actions bound to `<Keyboard>` listen to
  every keyboard, and the virtual one is made `Keyboard.current` for the run.

# qwen3.6-35b-a3b on the opencode-unity plugin: test report

Written for a second opinion on one question: **keep optimizing the tools, or change the model?**

Data collected on 2026-09-19 and 2026-09-20 by reading real sessions back from the opencode
database. No number here is estimated: every row comes from a query, and the end of this document
shows how to run them again.

## Short answer

Across **231 calls** to the plugin's tools in 7 sessions, the rejection rate depends almost
entirely on the **shape of the tools**, not on how hard the task is:

| Surface | Calls | Rejected | Rate |
|---|---|---|---|
| batch `unity_scene_edit` (one tool, nested JSON) | 76 | 56 | **74%** |
| flat (one tool per action, scalar arguments) | 80 | 8 | **10%** |
| read-only (`unity_scene_view`, `unity_status`, `unity_console`) | 75 | 3 | 4% |

Same model, same project, same tasks. **The same work fails 7 times out of 10 or 1 time out of 10
depending on how the tool is built.** The 4 causes left on the flat surface were fixed on
2026-09-20, and one fix has already been verified again on the real model.

By day, as the tools were being fixed:

| Day | Unity calls | Rejected | Rate |
|---|---|---|---|
| 2026-09-19 | 104 | 56 | 54% |
| 2026-09-20 | 127 | 11 | 9% |

## Environment

| | |
|---|---|
| Model | `qwen3.6-35b-a3b`: 35B mixture-of-experts, ~3B active, quantized, served locally |
| Client | opencode (CLI `opencode run` and desktop) |
| Plugin | `opencode-unity` 0.1.0, 19 registered tools (~2,500 tokens of descriptions alone) |
| Unity | 6000.0.71f1, URP, Input System. Package `com.unity.pipeline` 0.7.0-exp.1 |
| Host | macOS, Apple Silicon |
| Latency | ~45 s for a one-word answer, minutes for a round with tools |

**About speed**: the model is slow enough to change how the work is done. Every end-to-end run has
to go in the background. That is a real cost when comparing models, not a detail.

## Catalogue of failures

Each one was observed in real sessions, not constructed. `→` is the fix that was applied.

### 1. Nested JSON in arguments (18 occurrences, all on the batch tool)

The model writes correct JSON when it **writes a file**, and broken JSON for the same content when
it is a **tool argument**. Always at the same spot in the structure.

```json
{"operations": [{"op": {"set": {"target": "/Ground", "scale": [200, 1, 200]}}},
                {"op": {"set": {"target": "/TrackRing", "component": "MeshRenderer"}}}]}
```
Expected shape: `{"op": "set", "target": ...}`. It nested the value under the key.

A worse variant, where the breakage is plain syntax:
```json
{"op": "create", "name": "Windows", "parent": "/Car",
 "primitive:": {"primitive": "cube", "position": [0, 0.3, 0]},
 "color: [0.8, 0.85, 0.9]}, {": {"op": "c...
```
Note `"primitive:"`, with the colon inside the key: it had copied the prose `(primitive: cube
sphere ...)` from the **tool description** into the key name.

→ One tool per action with scalar arguments. Structured things travel as plain text
(`"0, 1, 0"`, `"mass=1500; useGravity=true"`), and descriptions never put `word:` next to a JSON
example.

### 2. Values wrapped in invented types

```json
{"values": {"mass": {"$float": 1500}, "useGravity": {"$bool": true},
            "linearDamping": {"$float": 0.1}}}
```
The arguments were typed as "any object", and the model invented a protocol.
→ A typed schema that names every field; wrappers are unwrapped anyway if they arrive.

### 3. Stale paths after a move (7 consecutive calls)

The single most expensive cause. It renames `/Car` to `PlayerCar`, moves it under `/CarGroup`,
then:

```
unity_object_modify {"path": "/PlayerCar/Wheel_FL", "new_parent": "/CarGroup"}
  -> Scene NOT changed. No object at '/PlayerCar/Wheel_FL'.
     Closest: /CarGroup/PlayerCar/Wheel_FL ...        ← ×5, one per wheel
```
The success message only said `Done. Scene changed` and **never said where the object ended up**.
Later the model repeated a move that had just succeeded, because nothing had confirmed it.

→ Rename and re-parent now report the new path:
`'/Car' is now '/CarGroup/PlayerCar'. Its children moved with it. Use the new path from now on.`
**Verified again on the real model: see the A/B run below.**

### 4. Two roots read as parent and child (3 calls)

Right after reading the scene tree, it addressed `/CarGroup/Car/Body`. What it had read:

```
CarGroup
Car
  Body  [MeshFilter, BoxCollider, MeshRenderer]
```
`CarGroup` is empty, so it is a bare line; `Car` below it is bare too; then indented children. The
only signal was the indentation column, and the model did not hold it.

→ Roots carry their leading `/`: `/CarGroup`, `/Car`, then `  Body`. No extra lines, and the tree
itself shows the path syntax.

### 5. A component from a script that has not compiled yet

```
write  WheelVisual.cs                  -> Wrote file successfully.
unity_component_add  "WheelVisual"     -> Could not resolve component type 'WheelVisual'.
```
Then, verbatim (translated from Italian): *"Ah, Unity can't find the component. It probably needs
to recompile."* **It diagnosed the problem correctly and gave up anyway**, then deleted the script
with `bash rm` (leaving an orphaned `.meta`). The error named the fault, not the fix.

→ Unity's error is translated: *"WheelVisual.cs is in the project but Unity has not compiled it
yet. Call unity_compile, wait for it to pass, then add the component again."*

### 6. Duplicate component

A second `Rigidbody` on the same object. It went to Unity, which refused it and left an error in
the user's Console.
→ Stopped in the plugin, with a list of `[DisallowMultipleComponent]` types.

### 7. Tag that does not exist

`{"path": "/Car", "tag": "Car"}`: it wanted a tag the project did not have, and had **no way** of
knowing which ones existed.
→ The scene overview lists the project's tags and layers.

### 8. Repeating identical failed calls

Seen both on our tools (the same call 6 times) and on opencode's `edit` tool (7 identical failures
in a row on the same file, same `oldString`).
→ On our tools: from the third identical failed call on, the call is not executed.
**We cannot act on opencode's `edit` tool**: see "What is still open".

## The controlled run

Same prompt, same scene, same model, before and after fixes 3 and 4.

Prompt: *"Rename the Car object to PlayerCar, then move it inside CarGroup. Finally color the two
wheels black and the body red."*

**Before**: 10 calls, 3 rejections:
```
unity_scene_view {}
unity_scene_view {"path":"/CarGroup/Car/Body"}       -> No object at ...   ✗
unity_scene_view {"path":"/CarGroup/Car/Wheel_FL"}   -> No object at ...   ✗
unity_scene_view {"path":"/CarGroup/Car/Wheel_FR"}   -> No object at ...   ✗
unity_scene_view {"path":"/Car/Body"}
unity_scene_view {"path":"/Car/Wheel_FL"}
unity_scene_view {"path":"/Car/Wheel_FR"}
unity_object_modify {"path":"/Car","new_name":"PlayerCar","new_parent":"/CarGroup"}
unity_object_modify {"path":"/CarGroup/PlayerCar/Wheel_FL","color":"black"}
... (+2)
```

**After**: 5 calls, 0 rejections:
```
unity_scene_view {}
unity_object_modify {"path":"/Car","new_name":"PlayerCar","new_parent":"/CarGroup"}
unity_object_modify {"path":"/CarGroup/PlayerCar/Wheel_FL","color":"black"}
unity_object_modify {"path":"/CarGroup/PlayerCar/Wheel_FR","color":"black"}
unity_object_modify {"path":"/CarGroup/PlayerCar/Body","color":"red"}
```

Result checked **inside Unity**, not taken on the model's word:
```
Wheel_FL parent=PlayerCar color=RGBA(0.067, 0.067, 0.067, 1)
Wheel_FR parent=PlayerCar color=RGBA(0.067, 0.067, 0.067, 1)
Body     parent=PlayerCar color=RGBA(0.898, 0.224, 0.208, 1)
```

Worth noting: in the "after" run it did the rename and the move in **a single call** (the compound
case, the hardest one) and then addressed all three children right the first time.

## What is still open

These are **not** solved, and two of them do not depend on the plugin's tools.

1. **opencode's `edit` tool.** Seven identical failures in a row on `CarController.cs`, always
   `Could not find oldString`. Our loop breaker only covers our own tools. A small model cannot
   reproduce the exact spaces and indentation of a long block.
2. **`bash rm` on Unity assets.** The model gets around the file guards through the shell, and
   leaves orphaned `.meta` files. Observed, not hypothetical.
3. **Degradation with context length.** In sessions lasting hours the output degenerates. 19 tools
   already cost ~2,500 tokens before anything starts.
4. **It does not know what to ask before it has seen.** Relevant to the planned runtime module: a
   "watch" declared in advance assumes a capability that is rarely there at this size.

## On changing the model

**What the data says, honestly.**

For "fix the tools, not the model": the dominant variable measured is the shape of the tool, not
the task. 74% against 10% on the same application surface is a gap no reasonable model change
produces. And every fix so far came from reading sessions back, with a measurable effect (54% → 9%
in one day).

For "try another model": the 4 remaining causes **are no longer about shape**. They are about
capability: not holding an indentation column, not updating its picture of the scene after an
operation, not acting on a correct diagnosis it has just written, repeating an identical failed
call. On these the tool lever is almost used up: the latest fixes amount to **telling the model
what it should have inferred**. It works, but it is a patch per case.

**The experiment that would decide it**, not run here: run the **exact same set of tasks** on a
more capable model with the tools **as they were on 2026-09-19** (before the fixes). If a better
model gets under 20% rejections on that surface, capability buys what tool shape bought, and the
comparison becomes cost per task. If it stays above 50%, tool shape is the real lever and should be
pushed further.

The tasks are already written and reproducible: build a car out of primitives with groups and
children, rename and re-parent, add components and set their values.

**Two more measures worth collecting** in the comparison, besides the rejection rate: calls per
completed task (5 against 10 already says more than "it worked"), and time per task, where qwen is
heavily penalized by local latency.

## How to run the measures again

opencode sessions live in SQLite. Read-only:

```sql
-- every tool call, with input and output
select data from part
where session_id = '...' and json_extract(data, '$.type') = 'tool'
order by time_created;
```

```bash
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
  "select id, datetime(time_created/1000,'unixepoch','localtime'), title from session
   order by time_created desc limit 10;"
```

The rejection rate is the count of these markers in the outputs: `NOT changed`, `NOT created`,
`No object at`, `problems found before touching it`.

To run an end-to-end trial on a throwaway Unity project:
```bash
opencode run --model <provider>/qwen3.6-35b-a3b "<task>"     # from inside the project
```

## Related documents

- [small-model-tool-design.md](small-model-tool-design.md): the full catalogue of what failed and
  what fixed it, plus the rules of thumb that came out of it. The canonical document.
- [STATUS.md](STATUS.md): where the plugin stands: what is done, verified, broken.
- [runtime-module.md](runtime-module.md): design of the module that observes the running game,
  with the measurements taken on the Editor.

# qwen3.6-35b-a3b on the opencode-unity plugin: test report

Written for a second opinion on one question: **keep optimizing the tools, or change the model?**

Two sources, kept apart:

- **Real sessions** (2026-09-19 and 2026-09-20), read back from the opencode database: every row
  comes from a query, and the end of this document shows how to run them again.
- **A controlled benchmark on the same GPU** (2026-09-21 to 2026-09-24): scripted suites with
  programmatic checks, run directly against the model server. See
  [Hardware](#hardware-an-rtx-3060) and [Controlled benchmark](#controlled-benchmark-on-the-rtx-3060).

No number here is estimated.

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

The controlled benchmark later refined this: between those two days the error messages changed
together with the tool shape, and on the flat surface the messages turned out to be most of the
gain. See [Tool shape against error messages](#tool-shape-against-error-messages).

By day, as the tools were being fixed:

| Day | Unity calls | Rejected | Rate |
|---|---|---|---|
| 2026-09-19 | 104 | 56 | 54% |
| 2026-09-20 | 127 | 11 | 9% |

## Environment

| | |
|---|---|
| Model | `qwen3.6-35b-a3b`: 35B mixture-of-experts, ~3B active, Unsloth GGUF |
| Model server | llama.cpp on a single **NVIDIA RTX 3060 12 GB**, on the local network. See [Hardware](#hardware-an-rtx-3060) |
| Client | opencode (CLI `opencode run` and desktop) |
| Plugin | `opencode-unity` 0.1.0, 19 registered tools (~2,500 tokens of descriptions alone) |
| Unity | 6000.0.71f1, URP, Input System. Package `com.unity.pipeline` 0.7.0-exp.1 |
| Client host | macOS, Apple Silicon (runs opencode and Unity, not the model) |
| Latency | ~45 s for a one-word answer, minutes for a round with tools |
| Throughput in these sessions | 407 model replies, 196,266 output tokens in 3 h 16 min: ~17 tokens/s end to end, prompt processing included |

**About speed**: the model is slow enough to change how the work is done. Much of the ~45 s for a
one-word answer is thinking: with thinking on, the model was seen spending 1,400-1,500 tokens
before a short reply. Every end-to-end run has
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

## The A/B run

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
   already cost ~2,500 tokens before anything starts. The benchmark puts a number on one part of
   it: repeated identical calls go from 0.4 to 1.8 per trial between 24K and 60K tokens of context
   (see [Repeated calls grow with context](#repeated-calls-grow-with-context)).
4. **It does not know what to ask before it has seen.** Relevant to the planned runtime module: a
   "watch" declared in advance assumes a capability that is rarely there at this size.

## Hardware: an RTX 3060

The model runs on a home server, not on the Mac that runs opencode and Unity.

| | |
|---|---|
| GPU | NVIDIA GeForce RTX 3060, 12 GB (GA106, Ampere, `sm_86`), capped at ~94 W by the driver under load |
| CPU | Intel Xeon E5-1650 v4, 6 cores, 3.6 GHz |
| Memory | DDR4-2133 quad-channel; 32 GB for the inference container |
| Runtime | llama.cpp built with CUDA 12.8 (PrismML fork; upstream `ggml-org` measured identical on speed, see below) |
| API | OpenAI-compatible endpoint, called by opencode through `@ai-sdk/openai-compatible` |

The model file does not fit in 12 GB. What makes it usable is that it is a mixture of experts:
about 3B of its 35B parameters are active per token, so the expert weights of most layers stay in
system RAM and the CPU computes only the experts the router picks.

### Server settings

```
-ngl 99 -ncmoe 28 -c 102400 -b 2048 -ub 2048
--cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on --parallel 1
--spec-type ngram-mod
```

- `-ncmoe 28`: the expert weights of 28 layers stay on the CPU. More experts on the GPU means faster
  prompt processing but less VRAM for the KV cache.
- `-ub 2048`: the micro-batch left at its default of 512 was the main cause of a slow prompt phase.
  At 8K tokens: 349 t/s with `-ub 512`, 884 t/s with 2048 (2.5×). On a real 11K-token prompt: 14.8 s
  instead of 52 s.
- `-c 102400`: the context must match on both sides. With 65K on the server and 262K declared in
  opencode, the agent built 72K-token requests and the server refused them.
- KV cache in `q8_0`, ~12 KiB per token: 100K of context uses 9,741 MiB of VRAM.
- `--spec-type ngram-mod`: speculative decoding from n-grams already in the context. No draft
  model, no extra VRAM (see below).

Client side, the benchmark below recommends **temperature 0.3** and **thinking off**
(`enable_thinking: false`).

### Speed

Measured on the server, one session, no other load:

| Context depth | Prompt processing | Generation |
|---:|---:|---:|
| ~2K | 598 t/s | 31.6 t/s |
| ~32K | 766 t/s | 26.3 t/s |
| ~65K | 718 t/s | 23.9 t/s |
| ~99K | 660 t/s | 19.4 t/s |

Generation slows down as the context fills: the numbers quoted at an empty context are not the
numbers of a working session. The ~17 t/s of the real sessions above is lower still because it
counts prompt processing and thinking as well.

Speculative decoding depends entirely on the kind of output. Copying 196 lines that are already in
the context: 32.9 → **55.1 t/s** (+68%), with byte-identical output. On fresh reasoning it costs
5-10%.

Two sessions at once (`--parallel 2`, `-ncmoe 32`): ~20 t/s each, 39.7 t/s together.

## Controlled benchmark on the RTX 3060

Run between 2026-09-21 and 2026-09-24, directly against the model server (no opencode, no Unity).
Every result is **checked by code**, never taken on the model's word. The harness is not part of
this repository.

| Suite | What it measures |
|---|---|
| A: argument fidelity | 10 single-call cases: exact paths, C# saved unchanged, escaping, accents, nested objects, enums, number types, regex, long content, and a case that checks it does *not* invent optional parameters |
| B: multi-turn | 7 scenarios on a deterministic fake Unity project; chains of 1 to 8 steps where step N needs a path known only from the result of step N−1 |
| C: hard cases | 196 lines reproduced verbatim inside a JSON argument; an edit anchored on an exact string; three parallel calls |
| D: Unity plugin | Tools never seen in training, 19-digit `fileID`s and 32-hex GUIDs to copy exactly, a documentation tool that has to beat the model's memory |
| E: tool surfaces | The same tasks on the *batch* and *flat* surfaces, crossed with the error messages from *before* and *after* the fixes of 2026-09-20 |

Suites A-D run with **13 competing tools** and **~24,000 tokens of irrelevant context** already in
the history. Samples are small: two repetitions per case.

### Temperature and thinking

| Qwen3.6 setting | Suite A | Suite B | Suite C |
|---|---:|---:|---:|
| temperature 1.0 (template default, used in the real sessions) | 90% | 100% | |
| temperature 0.3 | 97% | 100% | |
| temperature 0.3, 13 tools + 24K of context | **100%** | **100%** | 89% |
| temperature 0.3, thinking off | 100% | 100% | **100%** |

The failures that remain always have the same shape: **4,000-6,000 tokens spent thinking without
ever emitting the call**. From the agent's side that looks exactly like broken JSON.

### Repeated calls grow with context

Qwen3.6, same suite, different amounts of context:

| | at 24K | at 60K |
|---|---:|---:|
| invented identifiers | 0.6 per trial | 0.7 per trial |
| **identical repeated calls** | **0.4 per trial** | **1.8 per trial** |

Invented identifiers stay flat; repeated calls grow more than four times. Failure 8 above is not a
generic flaw: it gets worse as the session gets longer. The plugin's loop breaker matters more,
not less, as a session goes on.

### Tool shape against error messages

The real sessions compare the batch surface on 2026-09-19 (74% rejected) with the flat surface on
2026-09-20 (10%). **Two things changed between those days**: the shape of the tools *and* the error
messages. Suite E separates them.

| Qwen3.6 | Tasks done | Calls | Rejected | Calls per task done |
|---|---:|---:|---:|---:|
| batch, messages before | 9/10 | 63 | 7 (11%) | 7.0 |
| batch, messages after | 10/10 | 70 | 17 (24%) | 7.0 |
| flat, messages before | 8/10 | 72 | 23 (32%) | 9.0 |
| flat, messages after | 8/10 | 48 | **1 (2%)** | **6.0** |

Almost all of the difference comes from one task, rename and re-parent (failure 3 above):

| rename + re-parent | batch, before | batch, after | flat, before | flat, after |
|---|---:|---:|---:|---:|
| done | 1/2 | 2/2 | 2/2 | 2/2 |
| rejected | 4 | 14 | 21 | **0** |
| calls | 21 | 28 | 35 | **12** |

1. **On the flat surface, better messages alone take rejections from 21 to 0** and calls from 35 to
   12. Same tools, only the messages changed.
2. **The rejection rate alone misleads.** Batch with the old messages looks good (4 rejections) but
   finishes 1 task out of 2: it has few rejections because it **gives up sooner**. With the new
   messages it finishes both and the rejections rise to 14, because it keeps trying. Always read
   the rejection rate next to the completion rate.
3. **With terse messages the flat surface is worse than batch** (32% against 11%): after a
   re-parent every child is a separate call, and each one hits the stale path.

Limit: the harness's copy of the batch tool is milder than the real one. Qwen3.6 is rejected 11%
of the time on it, not 74%.

### Other models on the same card

The same Unity suite, each model in the best configuration that really holds its context on 12 GB,
all with `ngram-mod`, temperature 0.3 and thinking off:

| | Qwen3.6-35B-A3B | Qwen3.8-27B GSQ `IQ2_XS` | Qwen3.8-27B `Q2_K_XL` | Ternary Bonsai 2 27B |
|---|---:|---:|---:|---:|
| Context, KV cache | 100K, `q8_0` | 88K, `q8_0` | 100K, `q4_0` | 100K, `q8_0` |
| VRAM | **9,741 MiB** | 11,581 MiB | 11,305 MiB | 10,273 MiB |
| Prompt processing, full context | **660 t/s** | 329 t/s | 328 t/s | 211 t/s |
| Generation, full context | **19.4 t/s** | 16.3 t/s | 15.5 t/s | 12.5 t/s |
| Unity suite | **10/10** | **10/10** | 9/10 | 8/10 |
| Invented identifiers | **4** | 8 | 22 | 27 |
| Identical repeated calls | **0** | **0** | 6 | 14 |
| Average turns | **3.4** | 3.6 | 4.5 | 5.2 |
| Suite time | **310 s** | 385 s | 502 s | 626 s |
| Hard cases | **6/6** | **6/6** | 4/6 | **6/6** |

Qwen3.6 stays the model to serve on this card. Qwen3.8-27B GSQ `IQ2_XS` (from IST-DASLab) is a
credible alternative when the context can stay under 88K.

What else the campaign found:

- **Quantizing the weights does not change tool calling.** Qwen3.8-27B at `Q2_K_XL` (9.8 GB) and
  `IQ3_XXS` (10.9 GB) scored identically on every surface. The extra gigabyte only pushes the model
  out of VRAM.
- **Quantizing the KV cache does, and no level is free.** On upstream llama.cpp, a `q8_0`/`q4_0`
  cache invents 17 identifiers against 12 for full `q8_0`, and repeats calls 5 times against once.
  On the fork, full `q4_0` invents 40 against 20, repeats calls 12 times against once, loses a task
  and takes 29% more time. Copying long blocks still works; recalling an opaque id seen ten turns
  earlier is what breaks.
- **Tokens per second alone mislead.** On the same 40 tasks Qwen3.8-27B `Q2_K_XL` generated 27%
  slower than Qwen3.6 (18.0 against 24.7 t/s) but also produced 27% fewer tokens: 583 s against
  579 s. What counts is the time to finish the task.
- **Dense models cannot spill to the CPU.** Qwen3.8-27B with 24 of its layers on the CPU drops from
  20.8 to 2.6 t/s. A mixture of experts can, which is why a 35B model is the fastest thing on this
  card.
- **The fork and upstream llama.cpp are equally fast**, speculative decoding included.

## On changing the model

**What the real sessions said.** The dominant variable was the shape of the tool, not the task:
74% against 10%. The 4 causes that remained after the fixes were no longer about shape but about
capability: not holding an indentation column, not updating its picture of the scene after an
operation, not acting on a correct diagnosis it had just written, repeating an identical failed
call. The latest fixes amount to **telling the model what it should have inferred**.

**The experiment proposed here to decide it has been run**, in suite E: the same tasks, with the
tools and messages as they were on 2026-09-19, on a stronger model. The threshold was 20%
rejections. Qwen3.8-27B (`Q2_K_XL`) did 10/10 with **4%** rejections and 5.5 calls per task, where
Qwen3.6 did 9/10 with 11% and 7.0. Across all four cells of suite E, Qwen3.8-27B stayed between 3%
and 6%, while Qwen3.6 moved between 2% and 32%.

**So: yes, a stronger model buys what the tool fixes bought.** Two caveats:

- The harness's batch tool is milder than the real one (Qwen3.6: 11% there, 74% in real use), so
  this is weaker evidence than a replay of the real surface.
- On a 12 GB card the stronger model is not free. It needs a lower-precision KV cache to reach
  100K, which brings back invented identifiers and repeated calls, or it has to stay under 88K.

**What that means for the plugin.** The fixes are not wasted: they cost nothing on a strong model
and they are what makes Qwen3.6, the fastest model that fits this card, reliable. Qwen3.6 with the
flat tools, the new messages, temperature 0.3 and thinking off is the configuration to use on an
RTX 3060. The next lever is on the model side, not in the tools: a stronger model that fits, or a
second card.

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

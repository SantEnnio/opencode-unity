# Designing tools a small model can actually use

Notes from building this plugin against qwen3.6-35b-a3b (a 35B mixture-of-experts model with about
3B active parameters, quantized, served locally). Everything here was learned by reading real
sessions back, not by guessing. Each failure below is now a regression test in
`packages/opencode-unity/test/`.

## How to find out what went wrong

opencode keeps every session in a local SQLite database (`~/.local/share/opencode/opencode.db`).
Opened read-only, the `part` table has each tool call with its input and output:

```sql
select data from part
where session_id = '...' and json_extract(data, '$.type') = 'tool'
order by time_created;
```

This beats any amount of reasoning about what a model "probably" does. The model's own diagnosis
of its failures was wrong more often than right ("the tool cannot find .mat files" was a corrupt
file; "limits on adding several components" was its own broken JSON).

## What failed, and what fixed it

| What the model did | Why | What fixed it |
|---|---|---|
| `{"op": {"create": {...}}}`, `{"create": {...}}` instead of `{"op": "create", ...}`. Ten calls in a row | The argument was typed as "any object": it could not see the fields and guessed the shape | A typed schema that names every field. A normalizer that accepts the wrong nestings anyway |
| Sent the identical failing call six times | The error said `unknown op '[object Object]'`, which told it nothing | Errors echo what was received and show the correct form |
| `"primitive:": {"primitive": "capsule", ...}`, always at the same spot | The tool description contained the prose `(primitive: cube sphere ...)` next to a JSON example, and the model copied `primitive:` into a key. There was also no example of the failing case (a child with a parent) | Descriptions with clean one-line examples covering the common cases, and no `word:` prose anywhere near them |
| Correct JSON when writing a file, broken JSON for the same content as a tool argument | Nested JSON inside a tool argument is simply unreliable at this size | **One tool per action with flat arguments.** Structured things travel as plain text: `"0, 1, 0"`, `"mass=1500; useGravity=true"` |
| `{"mass": {"$float": 1500}}`, `{"offset": {"$vector3": [...]}}` | Values were untyped, so it invented a type wrapper | Unwrap such wrappers; check each value against the kind of the property it replaces, before the engine sees it; say in the description how a number is written |
| Set `dry_run: true`, got "valid", never applied | It fills in every parameter it sees | Removed the parameter. Do not expose options a small model does not need |
| Kept referencing a material file that was on disk but corrupt (hand-written YAML from an earlier session) | "No asset at path" for a file that exists is a confusing message | Detect the corrupt file, say so, give the alternative |
| Ignored "STOP" and called again | A message is only advice | From the third identical failing call on, the call is not executed at all |
| A field was silently ignored (`"primitive:"` again), the tool said "applied", and the object was created empty | The tool was tolerant in the wrong way | Unknown fields are errors. Never report success for a request that was only partly understood |
| Degenerate output in a session that had been running for hours | Context far beyond what the model handles well | Nothing in the tool. New session, smaller tasks |

## Rules of thumb

1. **Flat arguments, one action per tool.** Scalars only. No arrays of objects, no free-form
   records. If several things must change, that is several calls.
2. **Plain text for structure**, parsed forgivingly: accept `,` `;` `=` `:`, brackets, quotes, a
   trailing `f` on floats, color names.
3. **Type everything in the schema.** An untyped argument is an invitation to improvise.
4. **Descriptions are training data.** The model imitates their surface. Use complete, correct,
   one-line examples of the calls you want, including the awkward cases. No pseudo-syntax.
5. **Be liberal in what you accept, never silent about what you dropped.**
6. **Validate before acting and answer with the fix**, not just the fault: the closest real names,
   the allowed values, the correct form of what was sent.
7. **Do the lookup for the model** and attach the result to the message it is already reading. It
   will not go and search on its own.
8. **End successful results with the next step.** A small model follows an explicit pointer far
   better than it plans.
9. **Enforce limits in code.** Loop breakers, guards and gates work; instructions in a prompt are
   suggestions.
10. **Few parameters, few tools.** Every optional parameter will be filled in sooner or later, and
    every tool costs context the model needs for the task.
11. **Short sessions.** Past a certain context length the failures stop being about your tool.

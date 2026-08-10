# Discoveries: Session-Scoped Hard-Data Memory

**Date:** 2026-08-09
**Status:** Approved, not yet implemented

## Problem

Every VLM call is stateless. `buildPrompt` in `vlmClient.js` rebuilds two
messages from scratch — a system template and one user message carrying the
current inventory, the action history, and exactly one image. The model sees
the current frame and a one-line-per-step log of what it did, and nothing else.

That log records *actions*, not *findings*. `formatHistoryLine` emits
`#3 click (0.42,0.13) -> changed`. Nowhere does the prompt carry a value the
model read off an earlier screenshot.

For any question that needs more than one reading, this is fatal. On the AirBnB
East vs. West Berlin dashboard, "Is the average number of beds for Houses
higher than that of All types, Apartments, and Hotels/Hostels?" requires
selecting each Property Type in turn and remembering four numbers. The agent
selects House, reads 3.3, clicks on, forgets it, and — with no record that it
already has that number — navigates back to House again. It burns the 15-step
budget cycling and ends on "Reached the maximum step budget before answering."

The same gap exists across turns. A follow-up question in a live conversation
starts a fresh `runSession` with `const history = []`, so nothing the agent
learned during the previous question survives, even though the dashboard is
the same page and has not been reloaded.

The fix is the one that worked on the DashboardQA dataset with Qwen 122B: make
the model write down each hard fact as it reads it, and feed every recorded
fact back on every subsequent step.

## Non-goals

Deliberately excluded from this spec:

- The `scroll` action (its own spec, later — see "Deferred" below)
- Structured or typed discoveries (key/value with overwrite-by-key)
- Memory that survives past the end of a session
- Any UI for editing, pinning, or deleting a discovery
- Contradiction resolution between two readings of the same thing
- `switch_tab` / multi-dashboard questions — this system runs one dashboard

## Scope of "session"

In the database a **session** row is one turn. In the UI, "End session" ends a
**conversation** — the long-lived `conversationRuntime` holding one Playwright
page across many turns. This spec uses the UI meaning: discoveries persist for
the life of the conversation and across every question asked within it.

## Key findings that shape the design

Verified in the code on 2026-08-09:

- `orchestrator.js:143` — `const history = []` is per-`runSession`, i.e. per
  turn. It is never sliced or capped; `buildPrompt` renders all of it.
- `vlmClient.js:333` — every call is `[system, user]` with exactly one image.
  No prior frames, no prior thoughts, no prior raw responses.
- `server.js:459` — `startTurn` calls `runSession` with `conversationId` and
  `turnIndex` already threaded through, and holds `activeRuntime`. There is a
  ready-made place to hang cross-turn state.
- `server.js:230` — the live path publishes a discrete `thought` SSE event
  (`{type, idx, text}`), consumed by `useBeatSequencer` and rendered by
  `ThoughtDisclosure` in `frontend/src/screens/Watch/Feed.jsx`.
- `server.js:194` — replay goes through `buildSessionTrajectory`, which maps
  `steps` rows into `{idx, thought, action, …}`. Both paths converge on the
  same step shape.
- `eval.js:89` and `run.js` pass `dashboard_url` to `runSession` **raw**. Only
  `server.js:354` calls `normalizeTableauViewUrl`. All four DashboardQA URLs
  below are in the `/app/profile/…/viz/…` browse form, which does not embed —
  run as-is they each burn the 90s open timeout and fail for a reason that is
  invisible, because per CLAUDE.md both URL forms return HTTP 200.
- `eval.js:56` — `matchesExpect` is case-insensitive substring matching. It
  cannot honestly score two of the four new questions: `expect: ["no"]` passes
  on *"Yes, houses are **no**tably higher"*, and `expect: ["nsw","qld"]` passes
  on the wrong answer *"NSW, QLD, and TAS"*.
- `eval/questions.json` has 9 scored questions, all single-reading or one-click.
  **None requires carrying a value across steps**, so the existing set can prove
  "we did not regress" but cannot prove this feature works.

Per CLAUDE.md, `actionSchema.js`, `vlmClient.js` and `orchestrator.js` are
frozen-core: they fail *silently*, degrading answer quality without throwing, so
no unit test catches a regression there. Every change to them in this spec is
gated on an eval accuracy comparison, not on tests passing.

## Architecture

```
screenshot ──► getNextAction ──► {discovery, thought, action}
                                      │
                    stampFromInventory(inv)  ← inv is the SAME frame's state
                                      │
                            discoveryLog.add(…)
                                      │
                    ┌─────────────────┴──────────────────┐
            persistAndEmit                       next step's buildPrompt
       (steps.discovery + SSE)              (CONFIRMED DISCOVERIES block)

  discoveryLog lives on the conversationRuntime object
  → created with the runtime, garbage-collected when it closes
```

### Component 1 — `backend/src/discoveries.js` (new)

Pure and I/O-free, in the same spirit as `activeConversation.js`,
`pixelGuard.js`, and `settleDecision` in `perception.js`: the decision logic is
extracted so it is unit-testable without Playwright or Express.

```js
createDiscoveryLog({ maxEntries = 40, maxChars = 200 })
  .add({ text, turnIndex, stepIdx, stateStamp })  // → { accepted, reason, evicted }
  .addNote(text)                                   // unlabeled system line
  .format()                                        // prompt block, or "" when empty
  .entries()                                       // copy, for inspection/tests
  .size()

stampFromInventory(inventory)                      // pure → "Property Type=House" | ""
```

`add` rejection reasons: `empty`, `none` (the model wrote a null-equivalent),
`duplicate`. Cap eviction is not a rejection — the entry is accepted and the
oldest is dropped, with `evicted` set so the orchestrator can emit a
`warning` event. The orchestrator emits that warning at most **once per
session**; the log itself is stateless about having warned.

`addNote` entries are stored in the same list, in chronological order, and
rendered by `format()` inline at their position — a takeover note therefore
sits between the readings that preceded it and those that follow. Notes carry
no `[T#]` label and are exempt from dedupe.

**Dedupe key is the stamped form, not the raw text.** `"avg beds = 3.3"` under
`Property Type=House` and under `Property Type=Apartment` are different facts
and must both survive; the same fact re-read under the same conditions is a
duplicate and is dropped. The key is lowercased and whitespace-collapsed.

**Cap** is 40 entries, FIFO. At ≤15 words each that is ~600 words worst case.

**No overwrite-by-key and no contradiction resolution.** If the model records a
value twice with different numbers, both appear, stamped and step-numbered,
newest last. Resolving them would require stable model-authored keys, and
`gemini-flash-lite` will not reliably produce them — the failure mode would be a
dedupe layer that silently does not dedupe.

`stampFromInventory` builds a compact prefix from state the orchestrator already
holds, ordered deterministically by id so it is testable:

- Active sheet name, when `inventory.sheets.length > 1`
- Parameters with a set `current` value (max 2)
- Categorical filters whose `applied` list is genuinely narrowed — non-empty,
  ≤3 values, and shorter than `domain` when the domain is known
- Range filters only when the applied bounds differ from the domain bounds

Capped at 3 entries and 80 chars total, truncated with `…` beyond that.

### Component 2 — `backend/src/actionSchema.js` (modified, frozen core)

One field on `StepResponseSchema`:

```js
discovery: z.union([z.string(), z.null()]).optional()
```

Optional is load-bearing. A required field turns a cosmetic omission into an
`invalid_json` step, and three of those in a row end the run. In a module that
fails silently, a new field must not be able to fail the old path.

### Component 3 — `backend/src/vlmClient.js` (modified, frozen core)

**`normalizeDiscovery(value)`**, applied before `safeParse` alongside the
existing `normalizeClickAction`, so a malformed discovery can never cause a
validation failure:

- trim and collapse whitespace
- strip a leading `Discovery:` if the model echoes the label
- map `none` / `n/a` / `na` / `nothing` / `-` (case-insensitive) to `null`
- coerce a number or array to a string
- truncate at 200 chars

**Response shape**, with `discovery` listed **first** in both templates, so the
model commits the reading to text before it reasons about what to do — the
ordering used in the DashboardQA Qwen prompt:

```json
{"discovery": "House avg beds = 3.3", "thought": "…", "action": {…}}
```

**New rules block**, added to *both* `SYSTEM_TEMPLATE` and
`PIXEL_SYSTEM_TEMPLATE`:

```
"discovery" records hard data visible in the CURRENT screenshot that you will need later:
- Numbers, names, labels, textual facts. Max 15 words.
- ALWAYS name what the value belongs to. Write "House avg beds = 3.3", never "avg beds = 3.3".
- Record NOTHING about the UI: not what is open or closed, not where a control is,
  not what you clicked.
- If this screenshot shows no new hard data, use null.

Discoveries persist for the WHOLE SESSION, including across follow-up questions, and are
shown back to you every step under CONFIRMED DISCOVERIES. Never navigate somewhere to
re-read a value that is already listed there.
```

The final sentence is the direct fix for the observed failure — the agent
re-navigating to House every other step.

**Existing rule 3 is amended** in both templates, from "Prefer `answer` as soon
as the current screenshot shows everything needed" to "…as soon as CONFIRMED
DISCOVERIES plus the current screenshot contain everything needed." Without
this, a model holding four remembered numbers still will not answer, because
the rule tells it to wait for one screenshot to show everything — which for a
comparison question never happens.

Both templates get the field. Memory is orthogonal to grounding strategy, and
giving it to only the pixel arm would confound the api-vs-pixel comparison that
the research half of the project owns.

**`buildPrompt` placement** — after HISTORY, before FEEDBACK:

```
CURRENT INVENTORY: …
HISTORY: …

CONFIRMED DISCOVERIES (facts you established earlier this session — trust them, do not re-derive):
[T1#3 | Property Type=House] avg beds = 3.3
[T1#6 | Property Type=Apartment] avg beds = 3.8

FEEDBACK ON YOUR LAST RESPONSE: …
Respond with the JSON object now.
```

History and discoveries read naturally together — *what I did*, then *what I
learned* — and sitting last puts the facts closest to the decision point. When
the log is empty the entire block is omitted rather than printed as `(none)`;
an empty labeled section costs tokens and invites the model to fill it.

Labels are `[T{turnIndex+1}#{stepIdx} | {stamp}]`. When `turnIndex` is null
(CLI and eval runs, which are standalone) the turn part is dropped, leaving
`[#3 | …]`. When the stamp is empty the separator is dropped too, leaving
`[T1#3]`.

**`getNextAction`** returns `discovery` alongside `thought` and `action`.

### Component 4 — `backend/src/orchestrator.js` (modified, frozen core)

`runSession` accepts an optional `discoveryLog` and defaults to
`createDiscoveryLog()` when none is passed. `run.js` and `eval.js` therefore
get per-run memory with no change to their call sites — a single-turn run still
accumulates across its 15 steps, which is what the new eval questions need.

Recording happens immediately after `getNextAction` returns valid, before the
action executes:

```js
const stamp = stampFromInventory(inv);
const rec = discoveryLog.add({ text: discovery, turnIndex, stepIdx: idx, stateStamp: stamp });
```

The inventory is read before the action executes and the screenshot the model
read is from the same moment, so `inv` is exactly the state the reading was
taken under. The pairing is correct by construction.

**The discovery is recorded even when the step's action is then rejected** — by
the loop guard, the dead-click guard, or the zoom-refine `notFound` verdict. A
rejected click does not invalidate the reading: the model looked at a frame and
read a number off it, and whether its aim was any good is a separate question.
This matters more than it sounds — rejected steps are common in pixel mode, and
discarding their readings would throw away a large fraction of what the agent
learns.

Discoveries are **not** recorded from re-prompt attempts that failed schema
validation. Only the attempt `getNextAction` actually returns is recorded.

`persistAndEmit` gains a `discovery` field (the raw normalized text, or null).

**`forceBestEffortAnswer` receives the log too.** It currently receives
`history` and would otherwise be the one call that flies blind — and it is the
single most important call, the forced answer at budget exhaustion, which is
exactly the state the reported failure ends in.

### Component 5 — `backend/src/conversationRuntime.js` (modified)

`createRuntime()` builds one `createDiscoveryLog()` and exposes it on the
runtime object. It lives exactly as long as the Playwright page. `close()`
drops the runtime; the log is garbage-collected with it. **That is the hard
delete** — no cleanup code, no table, no file.

Opening a different dashboard goes through `createConversationInternal`, which
closes the previous runtime and creates a new one, so a new dashboard starts
with an empty log automatically.

### Component 6 — `backend/src/server.js` (modified)

- `startTurn` passes `discoveryLog: activeRuntime.discoveryLog` into
  `runSession`.
- **Takeover marking.** `startTurn` already awaits `captureTakeoverEnd()` and
  holds the runtime. When that returns a takeover whose event log shows real
  interaction, it appends an unlabeled note before `runSession` starts:

  ```
  — the user changed the dashboard here; readings above may predate that change —
  ```

  Marking rather than clearing, because the user may have only panned or
  scrolled, and discarding correct facts is the worse error.
- `adaptAndPublish` extends the existing `thought` event rather than adding a
  new type: `{type: "thought", idx, text, discovery}`. One field, no new event
  type, no changes to `useBeatSequencer`'s ordering.
- `buildSessionTrajectory` adds `discovery: s.discovery`.

### Component 7 — `backend/src/store.js` (modified)

`ALTER TABLE steps ADD COLUMN discovery TEXT`, guarded by the same
duplicate-column catch as `error_message`. `insertStep` writes it; `getSteps`
already returns whole rows.

What is persisted is the **raw normalized model text** per step, not the
stamped aggregate — that is what reads well in the UI, and stamps are
re-derived at prompt time anyway.

**Scope boundary.** `steps.discovery` rows are trajectory history and survive in
SQLite like every other step field. They are never read back into any future
session's prompt. The *memory* — the thing that influences the agent — is only
ever the in-memory log, and it dies with the session.

### Component 8 — `frontend/src/screens/Watch/Feed.jsx` (modified)

Rendered inside `ThoughtDisclosure`, beneath the Thought: a small `DISCOVERY`
label with the text in JetBrains Mono, so it reads as recorded data rather than
prose, tinted with an accent so it is distinguishable at a glance in the
filmstrip. Omitted entirely when null, so quiet steps do not grow a blank row.

History replay needs no separate work — both paths converge on the same step
shape.

## Eval

### New file — `backend/eval/memory-questions.json`

Four rows from the DashboardQA dataset. Multi-hop questions that cannot be
answered without carrying a reading across steps.

| # | Dashboard | Question | Answer |
|---|---|---|---|
| 1 | AirBnBinEastvs_WestBerlin / AirBnBBerlin | Is the average number of beds for Houses higher than that of All types, Apartments, and Hotels/Hostels? | No |
| 2 | EnergyConsumptionAnimated / EnergyConsumption | If both nuclear and natural gas consumption increased from 1960 to 2010, which one grew faster during that time based on the charts? | Natural gas |
| 3 | CRSIPledges / CRSIPledges | Between NSW, QLD, and TAS State, can you list which of these have more pledges that state 'I am interested in providing friendship or recreational activities', and 'I am interested in helping a refugee get set up with school enrolments opening bank accounts, transport etc', in the 'Metropolitan' compared to 'Regional' location? | NSW, QLD |
| 4 | Citiesv2_2-Econ / Econ_Dashboard2 | Between the trends in office rental growth and retail rental growth from 2017-2022, which one fluctuates more? | Office Rental Growth |

URLs are kept **verbatim** in the `/app/profile/…/viz/…` browse form they came
in, for provenance fidelity with the dataset, and normalized at run time
instead.

The file header records that ground truth comes from the DashboardQA dataset
rather than our own inspection of a live capture. CLAUDE.md is emphatic that
eval ground truth rots silently and that an unverifiable green tick is worse
than no tick; the provenance must say which kind of truth this is.

### Harness changes this depends on

1. **`eval.js` and `run.js` call `normalizeTableauViewUrl`** on the dashboard
   URL. Two lines. Without them all four questions burn the 90s open timeout
   and fail invisibly.
2. **`matchesExpect` gains three primitives.** Existing string and array
   requirements are untouched, so `eval/questions.json` behaves identically.

   | Form | Meaning |
   |---|---|
   | `{"word": "no"}` | word-boundary match; array = any-of |
   | `{"not": X}` | negation of any requirement form (string, array, or object) |
   | `{"first": [A, B]}` | A's first occurrence must precede B's; B absent = pass |

   `first` takes exactly two operands, each a plain string, matched with word
   boundaries. If A is absent the requirement fails.

   `{"first": …}` exists specifically for this question class. Three of the
   four are comparatives, where *"Natural gas grew faster than nuclear"* and
   *"Nuclear grew faster than natural gas"* contain identical substrings and
   only ordering separates them.

### Gates, in order

Expect values cannot be written up front: you cannot build a discriminating
substring matcher without seeing the phrasing the agent actually produces. So
the ordering below is part of the spec, not an implementation detail.

1. **Baseline.** Before touching anything, run
   `npm run eval -- eval/questions.json` and record the accuracy. This is the
   only thing standing between this change and a silent frozen-core regression.
2. **Author `memory-questions.json`** with all four entries `scored: false`,
   and run it. Every question is expected to fail on the current system; the
   run's purpose is to capture the answer text and confirm the four dashboards
   open and are operable at all.
3. **Implement**, keeping `npm test` green throughout.
4. **Re-run the memory set** (still `scored: false`) and read the answers.
   Write `expect` values that separate the observed-correct phrasing from the
   observed-wrong phrasing, then flip the entries to `scored: true`.
5. **Regression gate.** Re-run `eval/questions.json`. Accuracy must not drop
   below the step-1 baseline.
6. **Feature gate.** `npm run eval -- eval/memory-questions.json` — **target
   ≥2/4**. Stated plainly rather than promising 4/4: memory is necessary for
   these questions but not sufficient, and question 3 is six readings deep on a
   model that struggles past two.
7. **Manual two-turn check** on Berlin in the Watch screen — ask the beds
   question, then a follow-up reusing a recorded number, and confirm the second
   turn does not re-navigate to read it again. This is the only check that
   exercises the cross-turn requirement, since the eval harness is single-turn.

## Staleness

A number read off a dashboard is only meaningful together with the filter state
it was read under. Three defenses, in order of how much work they do:

1. **The deterministic stamp** (Component 1). An unqualified `"avg beds = 3.3"`
   still lands as `[T1#3 | Property Type=House] avg beds = 3.3` and stays
   usable instead of poisoning every later step.

   *Honest limitation:* in pixel mode the agent filters by clicking marks, and
   mark-selection cross-filtering may not surface in the filter objects
   `getFiltersAsync` returns. The stamp is a strong hint, not a guarantee. It
   works cleanly on the Berlin dashboard because Property Type is a real filter
   dropdown.
2. **The prompt instruction** to always self-qualify, catching what the stamp
   misses.
3. **Takeover marking** (Component 6), for state changed by a human between
   turns.

## Failure modes

| Case | Behavior |
|---|---|
| Model omits `discovery` | Treated as null. No re-prompt, no penalty. |
| Model writes prose | Truncated at 200 chars, recorded anyway. |
| Model records UI state despite instructions | Recorded as noise. Cap + dedupe bound the damage; accepted, not defended against. |
| Log hits 40 entries | Oldest evicted, warning event emitted once. |
| Contradictory readings | Both kept, stamped and numbered. |
| Discovery on a rejected-action step | Kept, by design. |
| Discovery from a failed re-prompt attempt | Discarded. |
| Human takeover between turns | Note appended; entries kept. |

## Testing

New unit tests (`node:test`, run via `npm test`):

- `test/discoveries.test.js` — add / reject (`empty`, `none`, `duplicate`) /
  cap FIFO with `evicted` / `format` / label forms with and without
  `turnIndex` and stamp / `addNote` placement. `stampFromInventory` across:
  all-values filter (omitted), narrowed filter (included), range at domain
  bounds (omitted), range narrowed (included), >3 candidates (capped), empty
  inventory (`""`), multi-sheet (sheet name included).
- `test/eval-matcher.test.js` — `word`, `not`, `first`; plus proof that every
  existing `eval/questions.json` expect form behaves identically.

Extensions to existing tests:

- `vlmClient` — CONFIRMED DISCOVERIES block present when non-empty, omitted
  when empty, positioned after HISTORY and before FEEDBACK.
  `normalizeDiscovery` cases: `"None"` → null, `"Discovery: x"` → `"x"`,
  number → string, 500 chars → 200.
- `actionSchema` — missing, null, and string `discovery` all validate.

## Files

**New**

- `backend/src/discoveries.js`
- `backend/test/discoveries.test.js`
- `backend/test/eval-matcher.test.js`
- `backend/eval/memory-questions.json`

**Frozen core** (each needs the eval accuracy comparison, not just tests)

- `backend/src/actionSchema.js`
- `backend/src/vlmClient.js`
- `backend/src/orchestrator.js`

**Normal edit surface**

- `backend/src/store.js`
- `backend/src/server.js`
- `backend/src/conversationRuntime.js`
- `backend/eval.js`
- `backend/run.js`
- `frontend/src/screens/Watch/Feed.jsx`
- `CLAUDE.md` — the new module in the backend module map, the frozen-core
  change, and the two eval-harness fixes

## Deferred

**Resolved** by `2026-08-10-scroll-action-design.md`, implemented 2026-08-10.
Two of the guesses below turned out to be wrong in ways worth recording: the
settle semantics are simpler than expected (the plain pixels-only gate is
correct, since no bridge event ever fires), while the "right scrollable region"
problem was not about hitting the region at all — a wheel reaches it fine — but
about *not* using a DOM write, which desynchronizes a worksheet's labels from its
marks and produces plausible wrong readings.

**The `scroll` action** gets its own spec. It is a new variant in
`actionSchema.js`, a new branch in `actuator.js`, and a real Playwright
implementation (wheel events at a normalized point, which must land on the
right scrollable region inside a canvas-heavy container). It also has its own
settle semantics: a scroll produces pixel change with no bridge event, which is
precisely the case the `expectBridgeEvent` rule exists to distinguish.

It is genuinely useful — CLAUDE.md already records one eval question that is
unanswerable because an option sits below the fold — but landing it together
with this change would make the eval delta uninterpretable, since a shifted
accuracy number could not be attributed to either.

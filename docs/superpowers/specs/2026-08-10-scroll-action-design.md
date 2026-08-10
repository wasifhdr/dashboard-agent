# The `scroll` Action

**Date:** 2026-08-10
**Status:** Approved, not yet implemented
**Deferred from:** `2026-08-09-discoveries-memory-design.md` ("Deferred")

## Problem

The agent cannot reach content that is below the fold inside a chart. Tableau
clips a worksheet whose content exceeds its container and offers a scrollbar;
`actionSchema.js` has eight action types and none of them scroll, so anything
past the clip is permanently invisible to the agent no matter how many steps it
spends.

`eval/questions.json` already carries a question that is unanswerable for this
reason and is marked `scored: false` because of it:

> "Remote Ratio renders as a vertical stack of pie charts labelled 0, 50, ...
> with 100 apparently below the fold, and actionSchema has no scroll action -
> so it may not be answerable with the current action set at all. Both arms
> flailed on it (up to 16 steps, 8 rejected targets, max_steps)."

Confirmed on 2026-08-10: the pane really is scrollable and the `100` row really
is reachable. The question is answerable; the action set is what is missing.

## Non-goals

Deliberately excluded:

- **Horizontal scrolling.** Real overflow exists (`hOver=396` on one pane), but
  every case that currently blocks an answer is vertical, and a second axis
  doubles the aiming surface for no measured gain.
- **Drag-to-pan.** On a Tableau canvas a drag is usually a lasso select, so it
  would mutate dashboard state rather than move the view.
- **Scrolling the host page.** Nothing needs it, and it is actively guarded
  against (see "Host containment").
- **A semantic "scroll until X is visible" action** that loops internally. It
  would hide N VLM calls inside one step and make one trajectory step opaque.
- **Programmatic scrolling via the DOM.** Rejected on evidence — see below.
- **Restoring scroll position** after a filter change or on a new turn.

## Findings from the probe

All measured on 2026-08-10 against
`https://public.tableau.com/views/DataScienceSalariesintheUSDashboard/Dashboard1`
through the real `host.html`, viewport 1920×1200, viz element 1920×600.

**1. The overflow is real and structured as two panes.** The "Percent Remote
Roles vs. Company Size" pie stack is a `div.tvScrollContainer` at frame rect
`{x:1508, y:109, w:186, h:364}` with `scrollHeight` 586 against `clientHeight`
364 — **222px of hidden content**, about one pie row. A second instance exists
on the same dashboard: the top-left crosstab clips mid-"Executive" with 53px
hidden. Both panes carry a Tableau scrollbar, `div.tab-tvScrollY`, 9px wide,
immediately to their right (`x:1694` for the pie pane).

**2. `page.mouse.wheel()` scrolls it correctly.** After `wheel(0, 300)` over the
pane the capture shows `50` and `100` with their pies, the `0` row scrolled off
the top, and **labels aligned with marks**. It works because the wheel goes
through Tableau's own scroll handling, the same reason `page.mouse.click` already
works on the canvas: CDP input is dispatched at browser level and is unaffected
by the cross-origin iframe boundary. `dy` of 40 / 80 / 120 produce proportional
partial scrolls; 300 traverses this pane's whole overflow in one step.

**3. `scrollTop` is not a witness and must never be used as one.** It reads `0`
before the wheel, `0` after one wheel, `0` after five, and `0` after a `PageDown`
— while the pixels demonstrably moved. Tableau re-renders the pane rather than
natively scrolling it (the containers are `overflow-y: hidden`). Judging the
first probe by `scrollTop` produced a confident and completely wrong "the wheel
does nothing" conclusion.

**4. Writing `scrollTop` desynchronizes labels from marks, and the result is a
plausible wrong reading.** The row labels live in a *separate* scroll container
from the marks: `div.tab-tvYLabel` (`overflow=221`) beside
`div.tvScrollContainer` (`overflow=222`). Setting `scrollTop = 222` on the marks
container alone moved the pies while the labels stayed put, rendering the **`50`
pie next to the label `0`**. Nothing errors, nothing looks broken, and the model
would bank a mislabeled number as a confirmed discovery. This is why the
programmatic path is a non-goal rather than a fallback: it is worse than having
no scroll action at all.

**5. `computeChangedRegions` is sensitive enough to be the guard.** Measured
against the pre-scroll frame:

| wheel `dy` | `computeChangedRegions` | full-frame diff | pane-scoped diff |
|---|---|---|---|
| 40 | 2 regions | 0.5221% | 8.787% |
| 80 | 3 regions | 0.7977% | 13.498% |
| 120 | 3 regions | 1.4332% | 24.278% |
| wheel over empty margin | **0 regions** | 0.0000% | — |
| pane already at its end | **0 regions** | 0.0000% | 0.000% |

The concern that its 20×20 grid and 2%-per-cell threshold would be blind to a
small scroll in a sparse 186px-wide pane was wrong: even 40px is caught. So no
new pane-scoped differ is needed. Note the last two rows are **identical**: "at
the end" and "nothing here scrolls" both produce exactly zero, so one message
must cover both.

**6. No bridge event fires.** Every scroll settled with `sawBridgeEvent: false`
on the plain pixels-only gate. A scroll is a local re-render with no server
round-trip and no `FilterChanged` / `ParameterChanged` / `TabSwitched`.

**7. The host page never scrolled.** `window.scrollY` stayed `0` throughout and
the viz bounding box never moved, on a viz (1920×600) that fits the viewport.

## Design

### Action shape

```json
{"type":"scroll","nx":0.834,"ny":0.485,"direction":"down","target":"the Remote Ratio pie stack"}
```

A new variant in `actionSchema.js`:

```js
const ScrollAction = z.object({
  type: z.literal("scroll"),
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  direction: z.enum(["down", "up"]),
  target: z.string().optional(),
});
```

**No magnitude field, deliberately.** The model's documented failure mode is
writing the right digits at the wrong scale — decade slips, percentages, 0-1000
space, all handled by `rescalePair`. `nx`/`ny` survive that because `[0,1]`
catches it; a raw pixel `dy` has no such range check, and 3 vs 300 is the
difference between nothing moving and jumping past the target. The actuator
supplies the magnitude from config; scrolling further is another step.

`nx`/`ny` reuse the click coordinate space, so the magnitude rescue must extend
to `scroll` in **two** places, or it will not fire: the early return inside
`normalizeClickAction` (`if (!action || action.type !== "click") return action`)
*and* its call site in `getNextAction`, which is itself guarded by
`if (parsed?.action?.type === "click")`. Changing only the function leaves the
call site skipping scrolls entirely.

### Actuator

A new branch in `actuator.js`, alongside `click`:

```js
case "scroll": {
  const box = await page.locator(VIZ_SELECTOR).boundingBox();
  if (!box || !box.width || !box.height) {
    return { ok: false, error: "Viz element not measurable right now (mid-transition); try again." };
  }
  const { px, py } = vizPointToPagePixels(box, action.nx, action.ny);
  await page.mouse.move(px, py, { steps: 12 });
  await page.mouse.wheel(0, action.direction === "up" ? -notchPx : notchPx);
  return { ok: true, point: { nx: action.nx, ny: action.ny, px, py } };
}
```

`notchPx` comes from `config.pixel.scrollNotchPx ?? 300`. `executeAction` has no
`config` parameter today, so it is threaded in as a field on the action by the
orchestrator before execution, or passed as a new optional argument to
`executeActionWithTimeout` — the latter, since it keeps the action object exactly
what the schema validated.

`page.mouse.move` first is required — `wheel` dispatches at the current cursor
position. `vizPointToPagePixels` is reused unchanged.

`config.pixel.scrollNotchPx` defaults to 300, tunable without editing frozen
code.

### Settle

`waitForSettle(page, config.settleGate)` with **no** `expectBridgeEvent`. This is
the one mutating action that correctly takes the pixels-only path, and it is
exactly the case `settleDecision` was written to distinguish: passing
`expectBridgeEvent: true` would burn the full 4500ms `eventGraceMs` every scroll
waiting for an event that can never arrive. `settleDecision` itself needs no
change — the load/no-op branch already returns `settled` on stable pixels.

### Aiming

One `locateTarget` call, **no** `refineClickPoint`, and **never a rejection**.

- `refine`'s 22% window is built for a ~2.6%-tall dropdown row; a scrollable pane
  is 186×364 of a 1920×600 frame. Pane-level precision is all a wheel needs.
- `locate` stays because it is the pass that actually fixed the wrong-coordinate
  pathology, where the model named the right control while emitting a point 60%
  of the frame away.
- Never reject, because a mis-aimed wheel is now *proven* harmless: over empty
  margin it produced 0 regions and 0.0000% diff. Unlike a stray click, it cannot
  dismiss an open dropdown or select a mark. The cost of a miss is one step,
  which the guard below then explains.

So `scroll` does **not** enter `resolveClickPoint`. It gets its own smaller path:
call `locate`, use its point if it returns one, otherwise fall back to the
model's own `nx`/`ny`, and scroll either way.

### Dead-scroll guard

Reuses the existing post-action diff: capture a `_post` frame, run
`computeChangedRegions` against the pre-action frame, and treat
`regions.length === 0` as "did not scroll".

A new `deadScrollPoints` list in `orchestrator.js`, keyed on
**`{nx, ny, direction}`** — direction included because a pane that has bottomed
out must still be scrollable back up, and a key without direction would block
the recovery. Proximity test reuses `isNearDeadPoint` from `pixelGuard.js` after
filtering to the same direction; no new geometry code.

Because "at the end" and "nothing there scrolls" are indistinguishable (finding
5), the corrective feedback covers both:

> Your scroll at (0.83,0.49) changed nothing — that area is either already
> scrolled to its end or has nothing scrollable in it. Scroll somewhere clearly
> different, or answer from what is visible.

`actionKey` gains `scroll:${nx.toFixed(2)},${ny.toFixed(2)}:${direction}`.
Like `click`, `scroll` is excluded from the exact-repeat `dup` check — repeating
a scroll is the normal way to go further down a long pane.

The persisted frame stays the **pre-action** screenshot, and the `_post` capture
is deleted after diffing, exactly as the click branch already does. So the
trajectory shows the view the model was looking at when it decided to scroll.

### The guard lists must cross-clear

A scroll that changes the view invalidates every *click* judgement made against
the old view, and vice versa. Both directions are required:

- A scroll with `regions.length > 0` clears `deadClickPoints` and
  `rejectedAimPoints`, for the same reason a successful click already does: a
  point that held nothing before may hold the target now.
- A click that changes the view clears `deadScrollPoints`, since the pane that
  had nothing scrollable in it may have been replaced by one that does.

Missing either one produces a guard that over-rejects a legitimate action on
stale evidence — silently, since a rejection looks like normal loop-guard
behavior. `noDiffClicks` stays click-only; a scroll that moves nothing must not
push the agent toward the "the control may be hidden" advice, which is about
clicking. `consecutiveNonProgress` follows the existing rule: incremented when
the scroll changed nothing, reset to `0` when it did.

### Host containment

After the wheel, read `window.scrollX` / `window.scrollY`. If the host page
itself moved, reset it to `0,0` and report the step as having changed nothing.

Never observed (finding 7), but the failure it prevents is nasty and silent: a
scrolled host page moves the viz box, `vizExtractRect` returns `null`, and every
subsequent capture falls onto the clipped-screenshot path that causes the
live-view stutter — presenting as an unrelated rendering regression. Three lines
to make it structurally impossible.

### Prompt

`PIXEL_SYSTEM_TEMPLATE` only. The api-mode template is untouched, so the
comparison arm stays clean, and `getNextAction`'s existing mode check extends
from `action.type === "click"` to also reject `scroll` outside pixel mode, as
does the belt-and-suspenders branch in the orchestrator.

Added to the action list:

```
- {"type":"scroll","nx":0.83,"ny":0.49,"direction":"down","target":"the Remote Ratio pie stack"}
```

And a rule, plus one line in RECORDING DISCOVERIES:

> Some charts are taller than the space they are drawn in and are CUT OFF: a row
> only half drawn at the bottom edge, a list that ends abruptly, an axis that
> stops short. Scroll INSIDE that chart to see the rest — aim at the middle of
> the chart itself, not its title or the dashboard margin.

> Scrolling moves rows OFF the screen as well as on. Record what you can
> currently read as a "discovery" on the SAME turn that you scroll, or the value
> will be gone from the next screenshot.

That second rule needs no orchestrator change: `discoveryLog.add` already runs
on the pre-action frame's reading before the action executes, and a rejected or
dead step keeps its discovery. The existing ordering is already correct for
scroll; the prompt just has to tell the model to use it.

## Files touched

**Frozen core** — needs the eval accuracy comparison, not just unit tests:

- `backend/src/actionSchema.js` — `ScrollAction` variant
- `backend/src/vlmClient.js` — pixel template, `normalizeClickAction` extension,
  mode gate
- `backend/src/orchestrator.js` — `scroll` branch, `deadScrollPoints`,
  `actionKey`

**Normal edit surface:**

- `backend/src/actuator.js` — `scroll` case, `describeAction` case, and the
  optional `notchPx` argument on `executeActionWithTimeout`
- `backend/src/pixelGuard.js` — the direction-aware dead-scroll test, plus the
  extracted pure helper for cross-clearing the two guard lists
- `backend/config.json` — `pixel.scrollNotchPx: 300`
- `backend/eval/questions.json` — rewrite the Remote Ratio question as a scored
  one now that it is answerable
- `CLAUDE.md` — the action count (8 → 9), and the two gotchas from findings 3
  and 4
- `docs/superpowers/specs/2026-08-09-discoveries-memory-design.md` — mark the
  Deferred section as resolved by this spec

## Testing

Unit (`node --test test/*.test.js`, via `npm test`):

- `actionSchema.test.js` — a valid scroll parses; `direction` outside the enum
  fails; out-of-range `nx`/`ny` fail; a magnitude field is not accepted.
- `clickCoordRescale.test.js` — a scroll at `(83, 49)` rescales to
  `(0.83, 0.49)` exactly as a click does.
- `pixelGuard.test.js` — a dead-scroll point blocks the same point in the same
  direction and does **not** block the opposite direction.
- A cross-clearing test: a scroll that changed the view empties
  `deadClickPoints`, and a click that changed the view empties
  `deadScrollPoints`. This needs the guard-list bookkeeping factored out of the
  orchestrator loop into a small pure helper to be testable at all — worth doing,
  since it is the part most likely to rot silently.
- `prompt.test.js` — `scroll` appears in the pixel system template and is absent
  from the api one.
- A `settleDecision` case asserting a scroll (pixels stable,
  `expectBridgeEvent: false`) settles without waiting out `eventGraceMs`.

Integration, by hand against the running app:

- Data Science Salaries → *"What is the average salary for a remote ratio of
  100?"* — expect a scroll step whose frame shows the `100` row, then an answer.
- A scroll aimed at the empty left margin — expect one `ok` step reporting no
  change, the dead-scroll feedback, and no repeat at that point.

## Verification

`perception.js` is untouched, but three frozen-core modules are not, and they
fail silently. So:

1. `npm run eval -- eval/questions.json` **before** the change, recorded as the
   baseline. The scroll question stays `scored: false` for this run so the
   denominator matches.
2. Implement.
3. Re-run and compare. The Remote Ratio question moving from unanswerable to
   answered is the intended delta; any *other* question changing is a
   regression to investigate, not noise.

Ground truth in `questions.json` was read by eye on 2026-08-08 and can rot —
re-verify the new Remote Ratio expectation against a fresh capture before
trusting the number.

## Deferred

- Horizontal scroll, if a dashboard is found where an answer needs it.
- Scroll-position awareness in the prompt ("this pane is scrolled 60% down"),
  which would need a DOM read whose only honest source is Tableau's internal
  classes.
- The load-path settle gap found while probing: on this dashboard the initial
  capture is a narrow centered layout that Tableau reflows to full width seconds
  later, so step 1 reads a layout that no longer exists. Independent of scroll,
  tracked separately.

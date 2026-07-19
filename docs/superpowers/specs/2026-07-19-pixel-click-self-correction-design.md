# Pixel-Mode Click Grounding & Self-Correction — Design Spec

**Date:** 2026-07-19
**Status:** Approved design, pending implementation plan
**Scope:** Improve pixel-mode click grounding and self-correction. **Out of scope:** the separate structural issue that sheet/tab switching cannot be done by clicking because the viz is embedded with `hide-tabs` (owner will address separately).
**Builds on:** `2026-07-19-pixel-actuation-mode-design.md` (the pixel actuation feature).

## 1. Motivation — evidence from a live run

A pixel-mode run of the Zillow demo (*"Switch to the ZRI dashboard tab and report the ZRI value for the United States"*) failed by looping to death. Persisted trajectory (session `21b7b654`):

| step | click (nx, ny) | target | result |
|---|---|---|---|
| 1 | 0.42, 0.13 | ZRI tab | no change |
| 2 | 0.28, 0.13 | ZRI tab | no change |
| 3–6 | 0.42, 0.13 | ZRI tab | no change |
| 7 | 0.58, 0.13 | ZRI tab | no change |
| 8 | 0.42, 0.13 | ZRI tab | no change |
| … | … | … | … |
| — | — | — | **`max_steps`, no answer** |

Two failures of the *self-correction* machinery (independent of the hide-tabs structural cause, which is out of scope here):

1. **No spatial memory.** The history shown to the model reads `Click: ZRI tab -> ok` with no coordinates and no "did it work" — so the model cannot tell it already tried `0.42,0.13` and should move. It re-issued nearly the same click repeatedly.
2. **Self-correction is advisory, not enforced.** Today's no-diff feedback ("aim more precisely") *fired* but the model ignored it, re-clicking `0.42,0.13` six times. Nothing prevented the wasted clicks; the 15-step budget was burned with no answer.

This spec makes self-correction *enforceable* and gives the model spatial awareness. It does not attempt to improve coordinate *accuracy* (the run shows the model's aim was reasonable — it targeted the top strip where a tab would be; the target simply wasn't rendered) — a grounding overlay was considered and rejected as unindicated for the observed failure.

## 2. Goals / Non-goals

**Goals**
- The model sees, in its history, where it clicked and whether the click changed anything.
- No-diff corrective feedback is spatial (names the dead coordinate) and escalating.
- A loop-level guard rejects a click that lands near a recent no-change click, *before* executing it, so the agent cannot burn the budget hammering a dead spot.
- All changes gated to pixel mode / click actions; API mode byte-for-byte unchanged.

**Non-goals**
- Fixing tab/sheet switching under `hide-tabs` (separate, owner-led).
- Coordinate-accuracy aids (grid/marker overlays).
- Any change to `perception.js`, `inventory.js`, `actuator.js`, `actionSchema.js`, or the `eval/` sets.

## 3. Mechanics

All edits live in the frozen files `orchestrator.js` and `vlmClient.js`, gated on `(config.actuationMode ?? "api") === "pixel"` and/or `action.type === "click"`. The orchestrator click branch already computes `clickChanged` (the post-click pixel diff) — this design uses that existing signal.

### 3.1 Spatial memory in history
- Click history entries carry coordinates and outcome:
  `history.push({ idx, key, type: "click", status, nx, ny, changed })` where `changed` is the boolean `clickChanged` for executed clicks (and `false`/`undefined` for rejected/errored clicks — see formatter).
- `vlmClient.js`'s `describeActionForHistory` / `formatHistoryLine` render a click entry as:
  ```
  #3 click (0.42,0.13) -> no change
  #7 click (0.58,0.13) -> changed
  ```
  For a rejected (guard) or errored click, the existing `-> <status>` suffix already conveys the outcome; still include the coordinates: `#5 click (0.42,0.13) -> rejected_loop`.
- API-action history formatting is unchanged (the new branch is keyed on `type === "click"`).

### 3.2 Spatial, escalating no-diff feedback
Replace the generic click no-diff feedback with coordinate-named, escalating text (built in `orchestrator.js`'s click branch):
- **1st dead click:** *"Your click at (0.42,0.13) changed nothing — you missed the control or it is not on screen. Aim at a clearly different location."*
- **2+ consecutive dead clicks:** append *"You have clicked near (0.42,0.13) with no effect. Do not click there again. If several spots produce no change, the control may be hidden — answer from what is visible, or fail."*

The escalation reuses the existing consecutive-non-progress threshold (2), consistent with the pixel-actuation spec.

### 3.3 No-diff repeat guard (enforcement)
A session-scoped `deadClickPoints: {nx,ny}[]` maintained in `runSession`:
- **Record:** when a click executes and `clickChanged === false`, push its `(nx,ny)`.
- **Guard (before executing a click):** if the proposed `(nx,ny)` is within `DEAD_CLICK_RADIUS` (normalized Euclidean distance) of any point in `deadClickPoints`, **reject the click without executing** — no `page.mouse` dispatch, no settle cycle. Persist the step with status `rejected_loop`, emit the badge, `consecutiveNonProgress++`, set the escalated feedback (§3.2), push a history entry (§3.1 with the rejected status), and `continue`.
- **Lifecycle:** clear `deadClickPoints` whenever a click *does* change the view (`clickChanged === true`) — the UI moved, so prior dead spots are stale and must not over-reject.
- **Radius:** `DEAD_CLICK_RADIUS = 0.05` as a module constant, overridable via `config.pixel.deadClickRadius` (optional; defaults to 0.05 when absent).

Pure helper (exported for unit testing):
```js
export function isNearDeadPoint(point, deadPoints, radius) {
  return deadPoints.some((d) => Math.hypot(d.nx - point.nx, d.ny - point.ny) <= radius);
}
```

### 3.4 Prompt reinforcement
Strengthen the existing "no change" rule in `PIXEL_SYSTEM_TEMPLATE` (pixel prompt only):
> *"If a click produces no visible change, you missed the control or it is not on screen — NEVER repeat the same or a nearby click. Move to a clearly different location. If several clicks in a row change nothing, stop targeting that control: answer from what is visible, or fail."*

## 4. Backstop unchanged
Guard-rejected clicks still increment `idx` and `consecutiveNonProgress`, so the 15-step budget and the forced best-effort answer remain the ultimate terminator. The guard reduces *wasted settle cycles* and pushes the model to move; it does not replace the budget.

## 5. Testing

**Unit (`node:test`):**
- `isNearDeadPoint(point, deadPoints, radius)`: point within radius → true; outside → false; empty `deadPoints` → false; exactly-at-radius boundary → true.
- Click history formatting via `vlmClient._internal`: a `click` history entry renders `#N click (nx,ny) -> no change` / `-> changed` / `-> rejected_loop`; an API-action entry (`set_filter`, etc.) renders unchanged (regression).

**Integration / manual:** validate on a task whose **target control is visible on the initial view** — an on-canvas quick-filter or legend, which `hide-tabs` does *not* hide (unlike tabs). Confirm:
1. The history block shown to the model includes prior click coordinates + outcome.
2. A near-duplicate dead click is rejected pre-execution (a `rejected_loop` click step with no settle).
3. The run converges (answers) or exits early, rather than burning all 15 steps.

The concrete validation dashboard/question (an on-canvas control) will be identified during the verify step by test-driving a couple of candidates; the criterion is "clicking a visible control changes the view."

## 6. Frozen-core impact & acceptance gate
Touched frozen files: `orchestrator.js`, `vlmClient.js` — all edits gated on pixel mode / click actions.
- **Acceptance:** the backend unit suite stays green, including the existing API-mode regression test (proves the gated edits didn't disturb the API path); the two new unit tests pass; the manual pixel validation (§5) shows the guard rejecting a repeat and the loop no longer running to `max_steps` on a dead spot.

## 7. Rollout
1. `isNearDeadPoint` helper + unit test.
2. Click history entry (coords + `changed`) in `orchestrator.js`; formatter in `vlmClient.js` + unit test.
3. Dead-point guard + lifecycle + escalated feedback in the orchestrator click branch.
4. Pixel prompt line.
5. Manual pixel validation on an on-canvas-control task.

## 8. Open questions / risks
- **Radius tuning:** 0.05 normalized (~1/20 of the viz) may reject legitimately-distinct nearby controls on dense dashboards; it's config-overridable and the manual validation will sanity-check it.
- **Dead-point staleness across settle:** cleared on any changed click; a click that changes the view but leaves a *different* dead region is handled naturally (the list resets, new dead points accrue).
- **This does not make tab-switching work** — that's the separate hide-tabs issue; a pixel run that requires a hidden control will now *fail or answer early* (guard + escalation) instead of looping to `max_steps`, which is the intended, more graceful outcome.

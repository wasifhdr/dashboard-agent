# Pixel Click Grounding & Self-Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pixel-mode agent spatial memory of its clicks and make self-correction enforceable, so it stops looping to `max_steps` re-clicking a spot that produces no change.

**Architecture:** Three gated changes in the frozen core — (1) click history entries carry coordinates + a `changed` flag rendered into the model's history log; (2) a session-scoped dead-click guard rejects a click within a small radius of a recent no-change click *before* executing it; (3) escalating, coordinate-named no-diff feedback + a strengthened pixel prompt. A new pure helper `isNearDeadPoint` is unit-tested; the orchestrator wiring is verified by the suite + a live pixel run.

**Tech Stack:** Node ESM, `node:test` (unit), Playwright/`sharp`/`pixelmatch` (runtime), the pixel-actuation feature already in place.

## Global Constraints

- **Frozen agent core** (`CLAUDE.md`): `orchestrator.js` and `vlmClient.js` are frozen. Every edit here MUST be gated on `(config.actuationMode ?? "api") === "pixel"` or on `action.type === "click"` so **API-mode behavior is byte-for-byte unchanged** (same prompts, same history rendering for API actions, same control flow). `perception.js`, `inventory.js`, `actuator.js`, `actionSchema.js`, and the `eval/` sets are NOT modified.
- **API-mode default** read as `config.actuationMode ?? "api"`.
- **Coordinate contract:** `nx, ny ∈ [0,1]` are fractions of the viz image. History renders coordinates as `nx.toFixed(2)` / `ny.toFixed(2)`.
- **Dead-click radius:** `config.pixel?.deadClickRadius ?? 0.05` (normalized Euclidean distance). Default 0.05.
- **Backstop unchanged:** guard-rejected clicks still increment the step index and `consecutiveNonProgress`; the 15-step budget + forced best-effort answer remain the terminator.
- **Test scoping:** run the unit suite with `npm test` (which is `node --test test/*.test.js`), never bare `node --test` (it picks up `scripts/vision-smoke-test.js`). Run backend commands from `backend/`.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**Created**
- `backend/src/pixelGuard.js` — pure `isNearDeadPoint(point, deadPoints, radius)` helper (no deps, so its test is fast and side-effect-free).
- `backend/test/pixelGuard.test.js` — unit tests for the helper.
- `backend/test/clickHistory.test.js` — unit tests for click history formatting + the strengthened pixel prompt.

**Modified**
- `backend/src/vlmClient.js` [frozen] — `describeActionForHistory`/`formatHistoryLine` render click entries with coords + outcome; strengthen the pixel-prompt no-change rule.
- `backend/src/orchestrator.js` [frozen] — import `isNearDeadPoint`; add `deadClickPoints`/`deadClickRadius`; rewrite the pixel click branch (dead-click guard, coords+`changed` history entries, escalating spatial feedback, dead-point lifecycle).

---

### Task 1: `isNearDeadPoint` pure helper

**Files:**
- Create: `backend/src/pixelGuard.js`
- Test: `backend/test/pixelGuard.test.js`

**Interfaces:**
- Produces: `isNearDeadPoint(point, deadPoints, radius) -> boolean`, where `point`/each `deadPoints[i]` is `{ nx:number, ny:number }` and `radius` is a number. Returns true iff `point` is within `radius` (normalized Euclidean) of any dead point.

- [ ] **Step 1: Write the failing test**

Create `backend/test/pixelGuard.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { isNearDeadPoint } from "../src/pixelGuard.js";

test("empty dead-point list is never near", () => {
  assert.equal(isNearDeadPoint({ nx: 0.5, ny: 0.5 }, [], 0.05), false);
});

test("a point within the radius is near", () => {
  assert.equal(isNearDeadPoint({ nx: 0.42, ny: 0.13 }, [{ nx: 0.43, ny: 0.13 }], 0.05), true);
});

test("a point outside the radius is not near", () => {
  assert.equal(isNearDeadPoint({ nx: 0.42, ny: 0.13 }, [{ nx: 0.60, ny: 0.60 }], 0.05), false);
});

test("matches when any of several dead points is near", () => {
  const dead = [{ nx: 0.10, ny: 0.90 }, { nx: 0.43, ny: 0.14 }];
  assert.equal(isNearDeadPoint({ nx: 0.42, ny: 0.13 }, dead, 0.05), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pixelGuard.test.js` (from `backend/`)
Expected: FAIL — `isNearDeadPoint` is not defined / module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/pixelGuard.js`:

```js
// Pure geometry helper for the pixel-mode dead-click guard (kept in its own
// dependency-free module so it can be unit-tested without importing the
// orchestrator's heavy deps). A "dead point" is the normalized location of a
// click that produced no visible change; a new click within `radius`
// (normalized Euclidean distance) of any dead point is rejected before it
// executes, so the agent can't burn its step budget hammering the same spot.
export function isNearDeadPoint(point, deadPoints, radius) {
  return deadPoints.some((d) => Math.hypot(d.nx - point.nx, d.ny - point.ny) <= radius);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pixelGuard.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/pixelGuard.js backend/test/pixelGuard.test.js
git commit -m "$(cat <<'EOF'
Add isNearDeadPoint helper for the pixel dead-click guard

Pure, dependency-free normalized-distance check used to reject a click
near a location that already produced no change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Click history rendering + pixel prompt reinforcement

**Files:**
- Modify: `backend/src/vlmClient.js:61-72` (`describeActionForHistory` / `formatHistoryLine`), and the pixel prompt rule at `backend/src/vlmClient.js:128`
- Test: `backend/test/clickHistory.test.js`

**Interfaces:**
- Consumes: history entries for clicks (produced by Task 3) shaped `{ idx, type:"click", status, nx, ny, changed }`.
- Produces: `formatHistoryLine(h)` (exported via `_internal`) renders a click entry as `#<idx> click (<nx>,<ny>) -> <outcome>`, where `outcome` is `"changed"`/`"no change"` for a `status:"ok"` click and the raw `status` otherwise. API-action rendering is unchanged.

- [ ] **Step 1: Write the failing test**

Create `backend/test/clickHistory.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { formatHistoryLine, buildPrompt } = _internal;

test("ok click with no change renders coords + 'no change'", () => {
  assert.equal(
    formatHistoryLine({ idx: 3, type: "click", status: "ok", nx: 0.42, ny: 0.13, changed: false }),
    "#3 click (0.42,0.13) -> no change",
  );
});

test("ok click that changed the view renders coords + 'changed'", () => {
  assert.equal(
    formatHistoryLine({ idx: 7, type: "click", status: "ok", nx: 0.58, ny: 0.13, changed: true }),
    "#7 click (0.58,0.13) -> changed",
  );
});

test("rejected click renders coords + its status", () => {
  assert.equal(
    formatHistoryLine({ idx: 5, type: "click", status: "rejected_loop", nx: 0.42, ny: 0.13, changed: false }),
    "#5 click (0.42,0.13) -> rejected_loop",
  );
});

test("api-action history is unchanged (regression)", () => {
  assert.equal(formatHistoryLine({ idx: 3, type: "set_filter", status: "ok" }), "#3 set_filter -> ok");
  assert.equal(formatHistoryLine({ idx: 4, type: "wait", status: "ok" }), "#4 wait -> ok");
});

test("pixel prompt carries the strengthened no-change rule", () => {
  const { systemText } = buildPrompt({
    question: "q",
    inventory: { sheets: [], filters: [], parameters: [] },
    history: [],
    mode: "pixel",
  });
  assert.match(systemText, /NEVER repeat the same or a nearby click/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/clickHistory.test.js` (from `backend/`)
Expected: FAIL — click entries currently render as `#3 click -> ok` (no coords), and the prompt lacks the new rule.

- [ ] **Step 3: Update the history formatter**

In `backend/src/vlmClient.js`, replace `describeActionForHistory` and `formatHistoryLine` (currently lines 61-72) with:

```js
function describeActionForHistory(h) {
  if (h.type === "click") return `(${h.nx?.toFixed(2)},${h.ny?.toFixed(2)})`;
  if (h.values !== undefined) return `${h.target_id}=${JSON.stringify(h.values)}`;
  if (h.value !== undefined) return `${h.target_id}=${JSON.stringify(h.value)}`;
  if (h.min !== undefined || h.max !== undefined) return `${h.target_id}=[${h.min ?? "?"}..${h.max ?? "?"}]`;
  if (h.target_id) return h.target_id;
  return "";
}

// For a click, the model cares whether it worked, not the internal step
// status — so an executed ("ok") click reports "changed" / "no change".
// Rejected/errored clicks keep their status so the model sees they didn't run.
function clickOutcome(h) {
  if (h.status === "ok") return h.changed ? "changed" : "no change";
  return h.status;
}

function formatHistoryLine(h) {
  const detail = describeActionForHistory(h);
  const outcome = h.type === "click" ? clickOutcome(h) : h.status;
  return `#${h.idx} ${h.type}${detail ? " " + detail : ""} -> ${outcome}`;
}
```

- [ ] **Step 4: Strengthen the pixel prompt no-change rule**

In `backend/src/vlmClient.js`, in `PIXEL_SYSTEM_TEMPLATE`, replace rule 4 (currently line 128, `4. If your previous click changed nothing, aim more precisely at the actual control next time.`) with:

```
4. If a click produces no visible change, you missed the control or it is not on screen — NEVER repeat the same or a nearby click. Move to a clearly different location. If several clicks in a row change nothing, stop targeting that control: answer from what is visible, or fail.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/clickHistory.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the whole unit suite (regression)**

Run: `npm test` (from `backend/`)
Expected: PASS — all prior tests plus the new file; no API-mode formatter/prompt regressions.

- [ ] **Step 7: Commit**

```bash
git add backend/src/vlmClient.js backend/test/clickHistory.test.js
git commit -m "$(cat <<'EOF'
Render click coordinates + outcome in history; strengthen pixel prompt

The model now sees where it clicked and whether it worked
(#N click (nx,ny) -> changed | no change | <status>), and the pixel
prompt tells it never to repeat a no-change click. API-action history
and the API prompt are unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Orchestrator dead-click guard, spatial history entries, escalating feedback

**Files:**
- Modify: `backend/src/orchestrator.js` (top import; loop counters near line 138-157; the pixel click branch at lines 444-520)

**Interfaces:**
- Consumes: `isNearDeadPoint(point, deadPoints, radius)` from `./pixelGuard.js` (Task 1); the history entry shape `{ idx, key, type:"click", status, nx, ny, changed }` rendered by `formatHistoryLine` (Task 2).
- Produces: pixel click steps that (a) push `{nx,ny,changed}` into history, (b) reject a near-dead-point click with status `rejected_loop` before executing, (c) escalate coordinate-named feedback on no-change clicks, and clear dead points when a click changes the view.

This task has no new unit test (it needs a live Playwright page — covered by Task 4). Keep it gated and verify by module load + the unit suite.

- [ ] **Step 1: Import the guard helper**

In `backend/src/orchestrator.js`, add to the imports at the top (next to the other `./` imports):

```js
import { isNearDeadPoint } from "./pixelGuard.js";
```

- [ ] **Step 2: Declare the dead-click state near the loop counters**

In `backend/src/orchestrator.js`, find where `noDiffClicks` is declared (with the other `let`/counter declarations before the `while` loop). Immediately after that line, add:

```js
  const deadClickPoints = []; // {nx,ny} of clicks that produced no change (pixel mode); cleared when a click changes the view
  const deadClickRadius = config.pixel?.deadClickRadius ?? 0.05; // normalized radius for the repeat guard
```

- [ ] **Step 3: Rewrite the pixel click branch**

In `backend/src/orchestrator.js`, replace the entire `if (action.type === "click") { ... }` block (currently lines 444-520, from `if (action.type === "click") {` through its closing `}` right before `const resolved = tracker.resolve(action.target_id);`) with:

```js
    if (action.type === "click") {
      if ((config.actuationMode ?? "api") !== "pixel") {
        // Belt-and-suspenders: a click can only be produced in pixel mode.
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: "click is only valid in pixel actuation mode",
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: click not allowed", type: "click" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("This mode does not support click actions. Use the provided action types.");
        history.push({ idx, key, type: "click", status: "rejected_target", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // Enforced self-correction: reject a click near a location that already
      // produced no change, WITHOUT executing it (no wasted mouse dispatch or
      // settle cycle). The step budget + consecutiveNonProgress still terminate
      // a genuinely stuck run.
      if (isNearDeadPoint({ nx: action.nx, ny: action.ny }, deadClickPoints, deadClickRadius)) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Repeat click near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}), which already produced no change`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat dead click", type: "click" },
          clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback =
          `You already clicked near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) and nothing changed. Do NOT click there again. ` +
          `Aim at a clearly different location, or if several spots produce no change, the control may be hidden — answer from what is visible, or fail.`;
        history.push({ idx, key, type: "click", status: "rejected_loop", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      onEvent({ type: "agent_cursor", idx, nx: action.nx, ny: action.ny, phase: "move" });
      const execResult = await executeActionWithTimeout(page, null, action, config.actionTimeoutMs);
      onEvent({ type: "agent_cursor", idx, nx: action.nx, ny: action.ny, phase: "click" });

      if (!execResult.ok) {
        persistAndEmit({
          idx, thought, action, status: "error", errorMsg: execResult.error,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Error: click", type: "click" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(execResult.error);
        history.push({ idx, key, type: "click", status: "error", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      const settleResult = await waitForSettle(page, config.settleGate);
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      // Did the click visibly change anything? Diff a fresh post-click frame
      // against this step's pre-click frame. Drives the corrective feedback and
      // the dead-click guard; the persisted frame stays the pre-action
      // screenshot, matching api-mode semantics.
      const postPath = framePath.replace(/\.png$/, "_post.png");
      let clickChanged = true;
      try {
        await screenshotViz(page, postPath);
        const regions = await computeChangedRegions(framePath, postPath).catch(() => []);
        clickChanged = regions.length > 0;
      } finally {
        fs.rmSync(postPath, { force: true });
      }

      persistAndEmit({
        idx, thought, action, status: "ok",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "click" },
        clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null },
      });
      history.push({ idx, key, type: "click", status: "ok", nx: action.nx, ny: action.ny, changed: clickChanged });

      if (!clickChanged) {
        deadClickPoints.push({ nx: action.nx, ny: action.ny });
        noDiffClicks++;
        const base = `Your click at (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) changed nothing — you missed the control or it is not on screen. Aim at a clearly different location.`;
        correctiveFeedback =
          noDiffClicks >= 2
            ? `${base} You have now clicked with no effect more than once. If several spots produce no change, the control may be hidden — answer from what is visible, or fail.`
            : base;
        consecutiveNonProgress++;
      } else {
        // The view moved — prior dead spots are stale and must not over-reject.
        deadClickPoints.length = 0;
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
      }
      prevFramePath = framePath;
      continue;
    }
```

- [ ] **Step 4: Verify the module loads and the suite passes**

Run: `node -e "import('./src/orchestrator.js').then(()=>console.log('ok'))"` (from `backend/`)
Expected: prints `ok`.

Run: `npm test` (from `backend/`)
Expected: PASS — all unit tests (pixelGuard, clickHistory, and the pre-existing suite) green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/orchestrator.js
git commit -m "$(cat <<'EOF'
Add dead-click guard + spatial click history/feedback (pixel mode)

Click history entries now carry nx/ny + changed; a click within
deadClickRadius of a recent no-change click is rejected before it
executes (rejected_loop); no-change feedback names the coordinate and
escalates; dead points clear when a click changes the view. All gated
on pixel mode; api mode unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Live pixel validation (acceptance gate)

**Files:** none (verification only). Requires the running app (backend + frontend) in pixel mode with `CRAFTX_API_KEY` in the root `.env` and network access to CraftX.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Unit suite green**

Run: `npm test` (from `backend/`)
Expected: PASS — pixelGuard (4) + clickHistory (5) + the pre-existing suite, all green (proves API-mode formatter/prompt/regression untouched).

- [ ] **Step 2: Pick an on-canvas-control validation task**

Tab-switching is out of scope (blocked by `hide-tabs`), so choose a question whose target control is **visible on the initial dashboard view** — an on-canvas quick-filter, legend, or clickable mark (these are part of the dashboard layout and are NOT hidden by `hide-tabs`). Test-drive 1-2 candidates from `config.dashboards` and keep the one where a single click demonstrably changes the view. Suggested starting candidates:
- California Infectious Diseases → *"Filter to Male cases"* (the sex filter is an on-canvas quick-filter).
- Over the Hill (US Demographics) → *"Set the gender filter to Female"* (on-canvas gender control).

Confirm the chosen dashboard actually renders a clickable control in the screenshot (open it, look at step 1's frame) before relying on it.

- [ ] **Step 3: Run the validation task in pixel mode and observe**

With `actuationMode:"pixel"`, backend + frontend up, run the chosen question. Pull the trajectory (as during design):

```bash
SID=$(curl -s http://127.0.0.1:8788/api/sessions | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d)[0].id))")
curl -s "http://127.0.0.1:8788/api/sessions/$SID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const s of JSON.parse(d).steps){const a=s.action||{};console.log(s.idx,s.action_status,a.type,a.type==='click'?('('+a.nx+','+a.ny+')'):'' )}})"
```

Confirm all three:
1. **Spatial memory:** a later step's prompt history includes prior click coordinates (verify via the feed, or that the model references/avoids prior spots).
2. **Guard fires:** if the model repeats a no-change click, a step shows `action_status = rejected_loop` with no settle delay (the guard rejected it pre-execution).
3. **No death-loop:** the run either answers or exits early — it does NOT spend all 15 steps re-clicking one dead spot (contrast the pre-fix run, which hit `max_steps` with 8+ identical clicks).

- [ ] **Step 4: Record the result**

Note the outcome (answered / early-exit / step count) in the README pixel-mode section or an eval note, and confirm `config.actuationMode` is left as intended.

---

## Self-Review

**Spec coverage:**
- §3.1 spatial history → Task 2 (formatter) + Task 3 (entry fields). §3.2 escalating spatial feedback → Task 3. §3.3 dead-click guard + `isNearDeadPoint` + radius/lifecycle → Task 1 (helper) + Task 3 (guard, `deadClickPoints`, clear-on-change, `config.pixel.deadClickRadius`). §3.4 prompt → Task 2. §5 testing (isNearDeadPoint unit, formatter unit, manual on-canvas validation) → Tasks 1, 2, 4. §6 frozen-core gate → Global Constraints + Task 3 gating + Task 4 Step 1. All spec sections map to a task.
- Non-goals honored: no tab-switching fix; no grounding overlay; no `perception.js`/`inventory.js`/`actuator.js`/`actionSchema.js`/`eval` edits.

**Placeholder scan:** every code step shows complete code; commands have expected output. Task 4's "pick a candidate" is a genuine runtime discovery (which dashboard renders a clickable on-canvas control), with concrete named candidates and a confirmation step — not a hidden TODO.

**Type consistency:** `isNearDeadPoint(point, deadPoints, radius)` identical in Task 1 def/test and Task 3 call. History entry shape `{ idx, key, type:"click", status, nx, ny, changed }` produced in Task 3 matches what `formatHistoryLine`/`clickOutcome` read in Task 2. `config.pixel?.deadClickRadius ?? 0.05` used consistently. `deadClickPoints` (array of `{nx,ny}`) pushed/cleared in Task 3 and passed to `isNearDeadPoint`.

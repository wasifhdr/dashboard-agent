# Scroll Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a ninth action — a vertical mouse-wheel scroll at a normalized point on the viz — so it can read chart content that Tableau clips below the fold.

**Architecture:** The model emits `{type:"scroll", nx, ny, direction, target}` with no magnitude; the actuator moves the real mouse to that point on the shared Playwright page and dispatches a wheel event of a fixed configured size, which reaches Tableau's own scroll handling through CDP. Settling uses the plain pixels-only gate because a scroll fires no bridge event. A post-action pixel diff decides whether anything moved, feeding a direction-keyed dead-scroll guard.

**Tech Stack:** Node ESM, Playwright (`page.mouse.wheel`), zod, `node:test`, better-sqlite3, React + Tailwind v4 (frontend overlay), Google Gemini via the OpenAI-compatible endpoint.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-scroll-action-design.md`. Read it before Task 2.
- All backend commands run from `backend/`. Tests are `npm test` (never a bare `node --test`).
- **Vertical only.** No horizontal scroll, no drag-to-pan, no programmatic `scrollTop` writes — the last one desynchronizes Tableau's label column from its marks and produces plausible wrong readings.
- **Never judge a scroll by `scrollTop`.** It stays `0` no matter how far a Tableau pane has scrolled. The pixel diff is the only witness.
- `scroll` is pixel-mode only, exactly like `click`. The api-mode prompt and behaviour must not change — it is the comparison arm.
- Frozen-core files (`actionSchema.js`, `vlmClient.js`, `orchestrator.js`) fail silently; they are gated on the eval comparison in Task 1 and Task 10, not on unit tests alone.
- Never run `git add -A`. Stage only the files a task touches.
- Do not stage `backend/config.json`'s existing uncommitted `vlmApiKeyEnv` change; it is the user's local key switch. Add new config keys in a separate hunk and stage the file only when the task says to.
- `id="agentViz"` never `id="viz"`.
- New config keys: `pixel.scrollNotchPx` (default 300), `pixel.scrollDeadRadius` (default 0.10). Every read uses `?? ` defaults so a config without them works.

---

### Task 1: Close the open assumption and record the eval baseline — DONE 2026-08-10

**Outcome:** baseline **9/9 scored correct**, 2 unscored, no crashes, saved to `backend/eval/baseline-2026-08-10.csv`. The filter-reset question turned out to be untestable on this dashboard and was resolved by reasoning instead; ground truth for the new eval question is `M`. Full detail in the spec's "Findings, round 3" (findings 10–13).

This task had to run **before** any frozen-core edit, because it captures the accuracy baseline that Task 10 compares against.

The hover-artifact question this task originally carried is **already settled** — measured on the World Government Summit dashboard on 2026-08-10, the highlight our own `mouse.move` creates persists after the cursor leaves, which is why Task 5 baselines the guard diff with `beforeWheel` instead of parking the cursor. Do not re-probe it.

**Files:**
- Create: `<scratchpad>/probe-openq.mjs` (throwaway, not committed)
- Modify: `docs/superpowers/specs/2026-08-10-scroll-action-design.md` (append a "Findings, round 3" section)
- Create: `backend/eval/baseline-2026-08-10.csv` (copy of the baseline run)

**Interfaces:**
- Consumes: nothing.
- Produces: one documented fact (does a pane's scroll position survive a filter change?), plus the verified expected answer string for the new eval question in Task 10.

- [x] **Step 1: Record the eval baseline before touching frozen code**

The env var named by `config.pixel.vlmApiKeyEnv` must be set in the repo-root `.env` — currently `GEMINI_API_KEY_2`, not `GEMINI_API_KEY`; check the config rather than assuming. Run from `backend/`:

```bash
npm run eval -- eval/questions.json
```

Expected: it prints `Accuracy: n/m` and writes `eval/results.csv`. Note the exact `n/m` — that is the baseline. If it exits non-zero because a question failed, that is still a valid baseline; record it as-is.

- [x] **Step 2: Preserve the baseline so Task 10 can diff against it**

```bash
cp eval/results.csv eval/baseline-2026-08-10.csv
```

- [x] **Step 3: Write the probe for the open question**

Create `probe-openq.mjs` in the scratchpad directory. It answers one question — does a filter change reset a pane's scroll position? — and captures the `100` row cleanly for Task 10's ground truth. The tooltip/hover section is deliberately absent; that is already settled.

```js
import { pathToFileURL } from "node:url";
import path from "node:path";

const BACKEND = "D:/NSU/10th semester/CSE499B.17/dashboard-agent/backend";
const { launchBrowser, openSession, waitForSettle, screenshotViz, computeChangedRegions } =
  await import(pathToFileURL(path.join(BACKEND, "src/perception.js")).href);

const URL_SALARIES =
  "https://public.tableau.com/views/DataScienceSalariesintheUSDashboard/Dashboard1";
const HOST = "http://127.0.0.1:8990";
const SETTLE = { postActionWaitMs: 400, compareIntervalMs: 500, diffThresholdPct: 0.5, timeoutMs: 12000 };
// The pie pane, measured 2026-08-10 AFTER the late relayout settles.
const PANE = { x: 1508, y: 109, w: 186, h: 364 };

const browser = await launchBrowser();
try {
  const { context, page } = await openSession(browser, HOST, URL_SALARIES, { firstLoadTimeoutMs: 90000 });
  await waitForSettle(page, SETTLE);
  await page.waitForTimeout(6000); // wait out Tableau's late layout pass
  await waitForSettle(page, SETTLE);

  const box = await page.locator("tableau-viz#agentViz").boundingBox();
  const cx = box.x + PANE.x + PANE.w / 2;
  const cy = box.y + PANE.y + PANE.h / 2;

  // FILTER RESET: scroll to the bottom, apply a filter, see if it snaps back.
  await page.mouse.move(cx, cy, { steps: 8 });
  await page.mouse.wheel(0, 600);
  await waitForSettle(page, SETTLE);
  await screenshotViz(page, "./oq_scrolled.png");

  // getInventory() returns the RAW bridge shape - fieldName / filterType, NOT the
  // field / type that inventory.js's tracker.normalize() produces. Reading the
  // normalized names here silently matches nothing and reports a false UNKNOWN.
  const inv = await page.evaluate(() => window.__agentBridge.getInventory());
  const cat = (inv.filters ?? []).find((f) => f.filterType === "categorical" && (f.domain ?? []).length > 1);
  if (!cat) {
    console.log("FILTER RESET: no categorical filter with a usable domain; record as UNKNOWN");
  } else {
    const res = await page.evaluate(
      ({ field, values }) => window.__agentBridge.applyCategoricalFilter(field, values),
      { field: cat.fieldName, values: [String(cat.domain[0])] },
    );
    console.log(`  applied ${cat.fieldName} = ${cat.domain[0]} -> ${JSON.stringify(res)}`);
    await waitForSettle(page, SETTLE, { expectBridgeEvent: true });
    await screenshotViz(page, "./oq_afterfilter.png");
    const back = await computeChangedRegions("./oq_scrolled.png", "./oq_afterfilter.png").catch(() => []);
    console.log(`FILTER RESET: regions after filter = ${back.length} (inspect oq_afterfilter.png by eye)`);
  }

  // (c) Ground truth for the new eval question: capture the 100 row cleanly.
  await context.close();
} finally {
  await browser.close();
}
```

- [x] **Step 4: Run the probe with the backend up**

The backend must be running (it serves `host.html`). Verify first:

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8990/api/config
```

Expected: `200`. Then run the probe from the scratchpad directory:

```bash
node probe-openq.mjs
```

- [x] **Step 5: Read the captures by eye and settle both questions**

Open `oq_scrolled.png` vs `oq_afterfilter.png`: does the pane show the same rows, or has it jumped back to showing `0`? Open `oq_scrolled.png`: which Company Size colour dominates the `100` pie, per the Company Size legend (`L` blue, `M` orange, `S` red)?

Do not infer from the region counts alone — a count of 0 is meaningful, but any non-zero count needs the eye check to say what changed. This is the mistake that produced a confident, wrong "the wheel does nothing" during the design probe.

- [x] **Step 6: Append the findings to the spec**

Add a `## Findings, round 2` section to `docs/superpowers/specs/2026-08-10-scroll-action-design.md` recording, in one sentence each with the evidence: whether a filter change resets scroll position, and what the `100` pie shows. If the filter change does *not* reset scroll, also strike the "Restoring scroll position" non-goal and add a `## Deferred` bullet noting that a stale scroll position can persist into a later turn of a live conversation.

- [x] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-scroll-action-design.md backend/eval/baseline-2026-08-10.csv
git commit -m "Record the scroll baseline eval and settle two open probe questions"
```

---

### Task 2: `ScrollAction` in the schema, with coordinate rescue — DONE 2026-08-10 (`6ed858b`)

**Files:**
- Modify: `backend/src/actionSchema.js`
- Modify: `backend/src/vlmClient.js` (`normalizeClickAction`, and its call site in `getNextAction`)
- Test: `backend/test/actionSchema.test.js`, `backend/test/clickCoordRescale.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the `scroll` member of `ActionSchema` with fields `{type:"scroll", nx:number 0..1, ny:number 0..1, direction:"down"|"up", target?:string}`, consumed by Tasks 4–7. `_internal.normalizeClickAction(action, dims)` keeps its exact signature and now also rescales scrolls.

- [x] **Step 1: Write the failing schema tests**

Append to `backend/test/actionSchema.test.js`:

```js
test("valid scroll parses", () => {
  const r = ActionSchema.safeParse({ type: "scroll", nx: 0.83, ny: 0.49, direction: "down", target: "the pie stack" });
  assert.ok(r.success);
});

test("scroll without optional target parses", () => {
  assert.ok(ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5, direction: "up" }).success);
});

test("scroll direction outside the enum is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5, direction: "sideways" }).success, false);
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5 }).success, false);
});

test("out-of-range scroll coordinates are rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 1.4, ny: 0.2, direction: "down" }).success, false);
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 0.2, ny: -0.1, direction: "down" }).success, false);
});

test("a scroll magnitude is not part of the contract", () => {
  // The actuator owns the notch size; a model-supplied dy has no [0,1] range
  // check to catch a decade slip, which is the documented failure mode.
  const r = ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5, direction: "down", dy: 900 });
  assert.ok(r.success, "an extra key is stripped, not fatal");
  assert.equal(r.data.dy, undefined, "dy must not survive into the validated action");
});
```

- [x] **Step 2: Run them to verify they fail**

```bash
npm test
```

Expected: FAIL — the scroll cases report `Invalid discriminator value. Expected 'set_filter' | ... | 'click'`.

- [x] **Step 3: Add the schema variant**

In `backend/src/actionSchema.js`, after `ClickAction`:

```js
// Vertical-only. No magnitude field on purpose: the actuator supplies a fixed
// notch from config, because a model-supplied pixel delta has no [0,1] range
// check to catch the decade slips that rescalePair exists to rescue.
const ScrollAction = z.object({
  type: z.literal("scroll"),
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  direction: z.enum(["down", "up"]),
  target: z.string().optional(),
});
```

And add `ScrollAction` to the union, after `ClickAction`:

```js
export const ActionSchema = z.discriminatedUnion("type", [
  SetFilterAction,
  SetRangeFilterAction,
  SetParameterAction,
  SwitchSheetAction,
  ClickAction,
  ScrollAction,
  WaitAction,
  AnswerAction,
  FailAction,
]);
```

- [x] **Step 4: Run the schema tests to verify they pass**

```bash
npm test
```

Expected: PASS.

- [x] **Step 5: Write the failing rescue test**

Append to `backend/test/clickCoordRescale.test.js`:

```js
test("a scroll's coordinates are rescued exactly as a click's are", () => {
  const raw = { type: "scroll", nx: 83, ny: 49, direction: "down", target: "the pie stack" };
  const fixed = normalizeClickAction(raw, FRAME);
  assertClose(fixed.nx, 0.83);
  assertClose(fixed.ny, 0.49);
  assert.equal(fixed.direction, "down", "the rest of the action survives");
  assert.equal(fixed.target, "the pie stack");
  assert.ok(StepResponseSchema.safeParse({ thought: "scroll down", action: fixed }).success);
});

test("an in-range scroll is returned by identity, not copied", () => {
  const action = { type: "scroll", nx: 0.83, ny: 0.49, direction: "down" };
  assert.equal(normalizeClickAction(action, FRAME), action);
});
```

- [x] **Step 6: Run it to verify it fails**

```bash
npm test
```

Expected: FAIL — `normalizeClickAction` returns the action untouched because of its `type !== "click"` early return, so `fixed.nx` is still `83`.

- [x] **Step 7: Extend the rescue to scrolls, in both places**

In `backend/src/vlmClient.js`, change `normalizeClickAction`'s guard. Replace:

```js
function normalizeClickAction(action, dims) {
  if (!action || action.type !== "click") return action;
```

with:

```js
// Also covers "scroll", which reuses the click coordinate space and therefore
// the same right-digits/wrong-magnitude failure mode.
function normalizeClickAction(action, dims) {
  if (!action || (action.type !== "click" && action.type !== "scroll")) return action;
```

Then in `getNextAction`, replace the call-site guard:

```js
    if (parsed?.action?.type === "click") {
      parsed.action = normalizeClickAction(parsed.action, await frameDims());
    }
```

with:

```js
    // Both pixel-space actions, both subject to the same magnitude slips.
    if (parsed?.action?.type === "click" || parsed?.action?.type === "scroll") {
      parsed.action = normalizeClickAction(parsed.action, await frameDims());
    }
```

Changing only the function leaves the call site skipping scrolls entirely, so the rescue would never fire.

- [x] **Step 8: Run the full suite**

```bash
npm test
```

Expected: PASS, all files.

- [x] **Step 9: Commit**

```bash
git add backend/src/actionSchema.js backend/src/vlmClient.js backend/test/actionSchema.test.js backend/test/clickCoordRescale.test.js
git commit -m "Add the scroll action to the schema, with the same coordinate rescue as click"
```

---

### Task 3: Direction-aware dead-scroll guard and stale-guard clearing — DONE 2026-08-10 (`5992bde`)

Two pure helpers, so the trickiest bookkeeping in the change is testable without a browser.

**Files:**
- Modify: `backend/src/pixelGuard.js`
- Test: `backend/test/pixelGuard.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, both imported by Task 5:
  - `isNearDeadScroll(point, deadScrolls, radius)` — `point` is `{nx, ny, direction}`, `deadScrolls` is an array of the same shape; returns `boolean`. Only entries with a matching `direction` are considered.
  - `clearStaleGuards(guards)` — `guards` is `{deadClickPoints, rejectedAimPoints, deadScrollPoints}`, all arrays; empties all three **in place** and returns nothing.

- [x] **Step 1: Write the failing tests**

Append to `backend/test/pixelGuard.test.js`:

```js
import { isNearDeadScroll, clearStaleGuards } from "../src/pixelGuard.js";

test("a dead scroll blocks the same point in the same direction", () => {
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.84, ny: 0.50, direction: "down" }, dead, 0.10), true);
});

test("a dead scroll does NOT block the opposite direction", () => {
  // A pane scrolled to its end reports no change, but must stay scrollable back
  // up - a key without direction would make that recovery impossible.
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.83, ny: 0.49, direction: "up" }, dead, 0.10), false);
});

test("a dead scroll does not block a clearly different pane", () => {
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.30, ny: 0.20, direction: "down" }, dead, 0.10), false);
});

test("the scroll radius is pane-sized, so nibbling inside one dead pane is still blocked", () => {
  // The pie pane is 186x364 of a 1920x600 frame: ~0.10 wide, ~0.61 tall. A
  // click-sized 0.05 radius would let the model evade the guard by moving its
  // aim a few percent within the same dead pane.
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.88, ny: 0.55, direction: "down" }, dead, 0.10), true);
  assert.equal(isNearDeadScroll({ nx: 0.88, ny: 0.55, direction: "down" }, dead, 0.05), false);
});

test("clearStaleGuards empties all three lists in place", () => {
  const guards = {
    deadClickPoints: [{ nx: 0.1, ny: 0.1 }],
    rejectedAimPoints: [{ nx: 0.2, ny: 0.2 }],
    deadScrollPoints: [{ nx: 0.3, ny: 0.3, direction: "down" }],
  };
  const originals = [guards.deadClickPoints, guards.rejectedAimPoints, guards.deadScrollPoints];
  clearStaleGuards(guards);
  assert.deepEqual(guards.deadClickPoints, []);
  assert.deepEqual(guards.rejectedAimPoints, []);
  assert.deepEqual(guards.deadScrollPoints, []);
  // Identity matters: the orchestrator closes over these arrays, so replacing
  // them instead of emptying them would silently keep the stale ones alive.
  assert.equal(guards.deadClickPoints, originals[0]);
  assert.equal(guards.rejectedAimPoints, originals[1]);
  assert.equal(guards.deadScrollPoints, originals[2]);
});

test("clearStaleGuards tolerates a missing list", () => {
  const guards = { deadClickPoints: [{ nx: 0.1, ny: 0.1 }] };
  clearStaleGuards(guards);
  assert.deepEqual(guards.deadClickPoints, []);
});
```

- [x] **Step 2: Run them to verify they fail**

```bash
npm test
```

Expected: FAIL with `SyntaxError: The requested module '../src/pixelGuard.js' does not provide an export named 'isNearDeadScroll'`.

- [x] **Step 3: Implement both helpers**

Append to `backend/src/pixelGuard.js`:

```js
// The dead-scroll variant. Direction is part of the identity: a pane scrolled
// to its end reports "no change" exactly like a pane with nothing scrollable in
// it (measured: both give 0 changed regions and a 0.0000% frame diff), so the
// point gets recorded as dead - but scrolling back UP must still be allowed, or
// the agent can never undo an over-scroll.
//
// The radius is expected to be larger than the click one: the unit of scrolling
// is a whole pane (the measured pie pane is ~0.10 x 0.61 of the frame), not a
// control, so a click-sized radius lets the model evade the guard by shifting
// its aim a few percent inside the same dead pane.
export function isNearDeadScroll(point, deadScrolls, radius) {
  return isNearDeadPoint(
    point,
    deadScrolls.filter((d) => d.direction === point.direction),
    radius,
  );
}

// Every recorded guard judgement was made against a frame that no longer
// exists, so a view-changing action invalidates all of them at once: a click
// that found nothing may now land on the target, and a pane with nothing
// scrollable may have been replaced by one that scrolls. Emptied IN PLACE
// because the orchestrator closes over these arrays for the life of the run.
export function clearStaleGuards(guards) {
  for (const key of ["deadClickPoints", "rejectedAimPoints", "deadScrollPoints"]) {
    if (Array.isArray(guards[key])) guards[key].length = 0;
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add backend/src/pixelGuard.js backend/test/pixelGuard.test.js
git commit -m "Add the direction-aware dead-scroll guard and stale-guard clearing"
```

---

### Task 4: Actuator scroll branch and config keys — DONE 2026-08-10 (`ad536ae`)

**Files:**
- Modify: `backend/src/actuator.js`
- Modify: `backend/config.json`

**Interfaces:**
- Consumes: the `scroll` action shape from Task 2.
- Produces:
  - `executeActionWithTimeout(page, resolved, action, timeoutMs, opts = {})` — a **new fifth parameter**. `opts.notchPx` (number) is the wheel delta for a scroll; `opts.beforeWheel` (optional `() => Promise<void>`) is awaited after the cursor is positioned and before the wheel fires. Every existing 4-argument call site keeps working unchanged.
  - On success for a scroll: `{ok: true, point: {nx, ny, px, py}}`.
  - `describeAction(action, resolved)` returns `Scroll down: <target>` / `Scroll down (0.830, 0.490)` for a scroll.

- [x] **Step 1: Add the config keys**

In `backend/config.json`, extend the `pixel` block. Leave the existing `vlmApiKeyEnv` line exactly as it is on disk:

```json
  "pixel": {
    "vlmEndpoint": "https://generativelanguage.googleapis.com/v1beta/openai",
    "modelName": "gemini-flash-lite-latest",
    "vlmApiKeyEnv": "GEMINI_API_KEY_2",
    "scrollNotchPx": 300,
    "scrollDeadRadius": 0.10
  },
```

`300` is measured: it traverses the whole 222px overflow of the salaries pie pane in one step, and `40`/`80`/`120` produce proportional partial scrolls.

- [x] **Step 2: Thread `opts` through the timeout wrapper**

In `backend/src/actuator.js`, change the two signatures. Replace:

```js
async function executeAction(page, resolved, action) {
```

with:

```js
async function executeAction(page, resolved, action, opts = {}) {
```

And replace:

```js
export async function executeActionWithTimeout(page, resolved, action, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `Action timed out after ${timeoutMs}ms.` }), timeoutMs);
  });
  try {
    return await Promise.race([executeAction(page, resolved, action), timeout]);
```

with:

```js
// `opts` carries execution parameters that are NOT part of the model's validated
// action - currently opts.notchPx for a scroll. Kept off the action object so
// what the schema validated is exactly what gets executed and persisted.
export async function executeActionWithTimeout(page, resolved, action, timeoutMs, opts = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `Action timed out after ${timeoutMs}ms.` }), timeoutMs);
  });
  try {
    return await Promise.race([executeAction(page, resolved, action, opts), timeout]);
```

- [x] **Step 3: Add the scroll branch**

In `executeAction`, immediately after the `case "click"` block and before `default:`:

```js
      case "scroll": {
        const box = await page.locator(VIZ_SELECTOR).boundingBox();
        if (!box || !box.width || !box.height) {
          return { ok: false, error: "Viz element not measurable right now (mid-transition); try again." };
        }
        const { px, py } = vizPointToPagePixels(box, action.nx, action.ny);
        const notch = Number(opts.notchPx) > 0 ? Number(opts.notchPx) : 300;
        // move() first is required: wheel() dispatches at the CURRENT cursor
        // position, so without it the wheel lands wherever the mouse was left.
        await page.mouse.move(px, py, { steps: 12 });
        // Hook between the move and the wheel. Moving the cursor onto a pane
        // leaves a highlight on the row under it, and that highlight persists
        // even after the cursor leaves - so the caller needs a baseline taken
        // HERE, with the artifact already present, to tell a real scroll from
        // our own hover. Nothing else belongs in this window.
        if (typeof opts.beforeWheel === "function") await opts.beforeWheel();
        await page.mouse.wheel(0, action.direction === "up" ? -notch : notch);
        return { ok: true, point: { nx: action.nx, ny: action.ny, px, py } };
      }
```

- [x] **Step 4: Add the `describeAction` case**

In `describeAction`, after the `case "click"` line:

```js
    case "scroll":
      return `Scroll ${action.direction}${action.target ? `: ${action.target}` : ` (${action.nx.toFixed(3)}, ${action.ny.toFixed(3)})`}`;
```

- [x] **Step 5: Verify nothing regressed**

```bash
npm test
```

Expected: PASS. No test covers the actuator directly (it needs a browser), so this only confirms the module still parses and its importers are unaffected.

- [x] **Step 6: Commit**

```bash
git add backend/src/actuator.js backend/config.json
git commit -m "Execute a scroll as a wheel event at a normalized viz point"
```

---

### Task 5: Orchestrator scroll branch

The largest task. It wires aiming, settling, the guard, host containment, persistence, and the live-view event.

**Files:**
- Modify: `backend/src/orchestrator.js`

**Interfaces:**
- Consumes: `ScrollAction` (Task 2); `isNearDeadScroll` / `clearStaleGuards` (Task 3); `executeActionWithTimeout(..., opts)` and `describeAction` (Task 4).
- Produces: a persisted overlay field `scroll_point: {nx, ny, direction, target}` and an SSE event `{type:"agent_cursor", idx, nx, ny, phase:"scroll"}`, both consumed by Task 7.

- [ ] **Step 1: Import the new guards and add the state**

Change the `pixelGuard` import:

```js
import { isNearDeadPoint, isNearDeadScroll, clearStaleGuards } from "./pixelGuard.js";
```

After the `const rejectedAimPoints = [];` declaration, add:

```js
  // {nx,ny,direction} of scrolls that produced no visible change - the pane was
  // already at its end, or nothing there scrolls (indistinguishable: both give
  // 0 changed regions). Direction-keyed so scrolling back up stays possible.
  const deadScrollPoints = [];
  const scrollDeadRadius = config.pixel?.scrollDeadRadius ?? 0.10;
  const scrollNotchPx = config.pixel?.scrollNotchPx ?? 300;
  // One bundle so a view-changing action can invalidate every stale judgement
  // at once - see clearStaleGuards.
  const guards = { deadClickPoints, rejectedAimPoints, deadScrollPoints };
```

- [ ] **Step 2: Make `actionKey` cover scrolls**

In `actionKey`, after the `case "click"` return:

```js
    case "scroll":
      return `scroll:${action.nx.toFixed(2)},${action.ny.toFixed(2)}:${action.direction}`;
```

- [ ] **Step 3: Let `persistAndEmit` carry a scroll point**

Add `scrollPoint = null` to the destructured parameter list of `persistAndEmit` (beside `clickPoint = null`), and extend the overlay line. Replace:

```js
    const overlay = { action_badge: actionBadge, widget_bbox: widgetBbox, changed_regions: changedRegions, ...(clickPoint ? { click_point: clickPoint } : {}) };
```

with:

```js
    const overlay = {
      action_badge: actionBadge,
      widget_bbox: widgetBbox,
      changed_regions: changedRegions,
      ...(clickPoint ? { click_point: clickPoint } : {}),
      ...(scrollPoint ? { scroll_point: scrollPoint } : {}),
    };
```

- [ ] **Step 4: Exclude scrolls from the exact-repeat duplicate check**

Repeating a scroll is the normal way to travel further down a long pane, so it must not be rejected as a duplicate. Replace:

```js
    const dup =
      action.type !== "wait" && action.type !== "click"
        ? history.find((h) => h.key === key && h.status === "ok")
        : null;
```

with:

```js
    const dup =
      action.type !== "wait" && action.type !== "click" && action.type !== "scroll"
        ? history.find((h) => h.key === key && h.status === "ok")
        : null;
```

- [ ] **Step 5: Add the scroll branch**

Insert this immediately **after** the closing brace of the `if (action.type === "click") { ... }` block and before `const resolved = tracker.resolve(action.target_id);`:

```js
    if (action.type === "scroll") {
      if (!isPixelMode) {
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: "scroll is only valid in pixel actuation mode",
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: scroll not allowed", type: "scroll" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("This mode does not support scroll actions. Use the provided action types.");
        history.push({ idx, key, type: "scroll", status: "rejected_target", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // Cheap guard on the raw aim, before spending a locate call on a pane
      // already known not to move in this direction.
      if (isNearDeadScroll({ nx: action.nx, ny: action.ny, direction: action.direction }, deadScrollPoints, scrollDeadRadius)) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Repeat scroll ${action.direction} near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}), which already produced no change`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat dead scroll", type: "scroll" },
          scrollPoint: { nx: action.nx, ny: action.ny, direction: action.direction, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(
          `You already scrolled ${action.direction} near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) and nothing changed. ` +
            `That area is either already scrolled to its end or has nothing scrollable in it. Scroll somewhere clearly different, or answer from what is visible.`,
        );
        history.push({ idx, key, type: "scroll", status: "rejected_loop", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // Aiming: locate ONLY, and never a rejection.
      //
      // No zoom-refine: refine's 22% window is sized for a ~2.6%-tall dropdown
      // row, while a scrollable pane is ~0.10 x 0.61 of the frame - pane-level
      // precision is all a wheel needs.
      //
      // locate stays, though, and not to save a wasted step: a bad aim can land
      // on a DIFFERENT pane that is also scrollable, so the agent scrolls the
      // wrong chart, the pixels change, the guard reads it as success, and the
      // model then reads a chart it never meant to move. That is a wrong-answer
      // risk, not a cost. Never rejecting is safe because a wheel that hits
      // nothing is inert (measured: 0 regions, 0.0000% diff) - unlike a stray
      // click, it cannot dismiss a dropdown or select a mark.
      if (action.target) {
        const located = await locateTarget({ config, imagePath: framePath, target: action.target, stopSignal });
        if (located && !located.notFound) {
          action.nx = located.nx;
          action.ny = located.ny;
        }
      }

      // Re-check after aiming: locate may have snapped the point onto a pane
      // already known to be dead. Free - it is a pure function.
      if (isNearDeadScroll({ nx: action.nx, ny: action.ny, direction: action.direction }, deadScrollPoints, scrollDeadRadius)) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Located target sits on a pane that already produced no change when scrolled ${action.direction}`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat dead scroll", type: "scroll" },
          scrollPoint: { nx: action.nx, ny: action.ny, direction: action.direction, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(
          `"${action.target ?? "That area"}" is in a pane that would not scroll ${action.direction} - it is at its end, or nothing there scrolls. ` +
            `Scroll a different chart, or answer from what is visible.`,
        );
        history.push({ idx, key, type: "scroll", status: "rejected_loop", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      onEvent({ type: "agent_cursor", idx, nx: action.nx, ny: action.ny, phase: "scroll" });
      // beforeWheel fires after the cursor is in position and before the wheel,
      // giving the guard a baseline that already contains the hover artifact -
      // see the diff below for why that matters. All the geometry stays in the
      // actuator; this only needs a hook at the right moment.
      const preWheelPath = framePath.replace(/\.png$/, "_prewheel.png");
      const execResult = await executeActionWithTimeout(page, null, action, config.actionTimeoutMs, {
        notchPx: scrollNotchPx,
        beforeWheel: () => screenshotViz(page, preWheelPath),
      });

      if (!execResult.ok) {
        persistAndEmit({
          idx, thought, action, status: "error", errorMsg: execResult.error,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Error: scroll", type: "scroll" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(execResult.error);
        history.push({ idx, key, type: "scroll", status: "error", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // NO expectBridgeEvent. A scroll is a local re-render: it fires no
      // FilterChanged/ParameterChanged/TabSwitched, so requiring an event would
      // burn the full eventGraceMs on every scroll waiting for one that can
      // never arrive. This is the case settleDecision's !expectBridgeEvent
      // branch exists for.
      const settleResult = await waitForSettle(page, config.settleGate);
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      // Host containment. If the wheel bubbled past every pane to the host
      // page, the viz box moves, vizExtractRect returns null, and EVERY later
      // capture falls onto the clipped-screenshot path that makes the live view
      // stutter - a rendering regression with no obvious link to scrolling.
      // Undo it and treat the step as having moved nothing.
      const hostScrolled = await page
        .evaluate(() => {
          const moved = window.scrollX !== 0 || window.scrollY !== 0;
          if (moved) window.scrollTo(0, 0);
          return moved;
        })
        .catch(() => false);

      // Did the pane actually move? scrollTop is useless here - Tableau leaves
      // it at 0 and re-renders instead - so the pixel diff is the only witness.
      //
      // Diffed against the PRE-WHEEL frame (captured after the cursor was in
      // position), NOT against this step's persisted frame. Our own mouse.move
      // leaves a highlight on whatever row it lands on, and that highlight
      // PERSISTS after the cursor moves away - so against the step's original
      // frame, a wheel on a pane already at its end still shows the highlight
      // appearing and reads as a successful scroll. Baselining after the move
      // puts the artifact in both frames, leaving only real movement.
      const postPath = framePath.replace(/\.png$/, "_post.png");
      let scrollChanged = false;
      try {
        await screenshotViz(page, postPath);
        const regions = await computeChangedRegions(preWheelPath, postPath).catch(() => []);
        scrollChanged = regions.length > 0 && !hostScrolled;
      } finally {
        fs.rmSync(postPath, { force: true });
        fs.rmSync(preWheelPath, { force: true });
      }

      persistAndEmit({
        idx, thought, action, status: "ok",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "scroll" },
        scrollPoint: { nx: action.nx, ny: action.ny, direction: action.direction, target: action.target ?? null },
      });
      history.push({ idx, key, type: "scroll", status: "ok", nx: action.nx, ny: action.ny, changed: scrollChanged });

      if (!scrollChanged) {
        deadScrollPoints.push({ nx: action.nx, ny: action.ny, direction: action.direction });
        correctiveFeedback = hostScrolled
          ? `Your scroll moved the page instead of the chart, so the dashboard did not change. Aim INSIDE a chart that is visibly cut off, not at the dashboard's edge or margin.`
          : `Your scroll ${action.direction} at (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) changed nothing - that area is either already scrolled to its end or has nothing scrollable in it. ` +
            `Scroll somewhere clearly different, or answer from what is visible.`;
        consecutiveNonProgress++;
      } else {
        // The view moved, so every guard judgement made against the old frame
        // is stale - including the CLICK ones.
        clearStaleGuards(guards);
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
      }
      prevFramePath = framePath;
      continue;
    }
```

- [ ] **Step 6: Make a successful click clear the dead scrolls too**

In the existing click branch's success path, replace:

```js
        deadClickPoints.length = 0;
        rejectedAimPoints.length = 0;
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
```

with:

```js
        clearStaleGuards(guards);
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
```

This is the other half of the cross-clearing: a click that changes the view can replace a pane that had nothing scrollable with one that does, so a stale `deadScrollPoints` entry would wrongly reject a legitimate scroll.

- [ ] **Step 7: Do NOT try to park the cursor — it does not work**

Measured on the World Government Summit dashboard on 2026-08-10: moving the cursor onto an open dropdown highlights the row beneath it, and that highlight **persists after the cursor moves away** (cursor-parked vs cursor-moved-away: 0 changed regions, with the highlight visible in both). It is not a live hover state, so there is no "move the mouse somewhere harmless" fix.

The `beforeWheel` baseline in Step 5 is the mitigation, and it is sufficient: the artifact appears in both frames of the guard's comparison and cancels out. Do not add a park step on top — it would cost a screenshot and a settle cycle and remove nothing.

One residual effect is accepted rather than fixed: the highlight remains in the frame the model reads on the *next* step, and on a dropdown a highlighted row can look like a selected one. Watch for it in Task 9 Step 7; the frame also still shows the real selection in the filter card's own label, so the cues are contradictory rather than uniformly wrong.

- [ ] **Step 8: Verify the suite still passes**

```bash
npm test
```

Expected: PASS. These paths are not unit-testable (they need a browser); Task 9 exercises them for real.

- [ ] **Step 9: Commit**

```bash
git add backend/src/orchestrator.js
git commit -m "Run scroll actions through the agent loop, with a dead-scroll guard"
```

---

### Task 6: Teach the pixel prompt to scroll

**Files:**
- Modify: `backend/src/vlmClient.js` (`PIXEL_SYSTEM_TEMPLATE`, `getNextAction`'s mode gate, `describeActionForHistory`)
- Test: `backend/test/prompt.test.js`

**Interfaces:**
- Consumes: the `scroll` action shape from Task 2.
- Produces: the pixel system template advertises `scroll`; the api template still does not. History lines render as `#3 scroll down (0.83,0.49) -> changed`.

- [ ] **Step 1: Write the failing prompt tests**

Append to `backend/test/prompt.test.js`:

```js
test("pixel mode prompt offers the scroll action", () => {
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/"type":"scroll"/.test(systemText));
  assert.ok(/direction/.test(systemText));
});

test("api mode prompt never mentions scrolling", () => {
  // The api arm is the comparison arm; its prompt must not drift.
  const { systemText } = buildPrompt({ ...BASE, mode: "api", discoveries: "" });
  assert.ok(!/"type":"scroll"/.test(systemText));
  assert.ok(!/scroll/i.test(systemText));
});

test("the pixel prompt warns that scrolling loses what is on screen", () => {
  // Without this the model scrolls away the value it needed, because the prompt
  // carries only the CURRENT frame - discoveries are the only thing that
  // survives a scroll.
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/SAME turn that you scroll/.test(systemText));
});

test("a scroll renders in the history with its direction", () => {
  const line = _internal.formatHistoryLine({
    idx: 3, type: "scroll", direction: "down", nx: 0.83, ny: 0.49, status: "ok", changed: true,
  });
  assert.equal(line, "#3 scroll down (0.83,0.49) -> changed");
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm test
```

Expected: FAIL on all four — the template has no `scroll`, and `formatHistoryLine` renders `#3 scroll  -> ok`.

- [ ] **Step 3: Add scroll to the pixel template's action list**

In `PIXEL_SYSTEM_TEMPLATE`, in the "The `action` object must be exactly one of" list, after the click line:

```
- {"type":"scroll","nx":0.83,"ny":0.49,"direction":"down","target":"the Remote Ratio pie stack"}
```

- [ ] **Step 4: Add the two rules**

In the same template, append to the `Rules:` list (renumber nothing — add as the next number after the existing `6.`):

```
7. Some charts are TALLER than the space they are drawn in, and Tableau cuts them off: a row only half drawn at the bottom edge, a list that ends abruptly, an axis that stops short. Use "scroll" to see the rest, aiming at the middle of THAT chart - not its title, and not the dashboard's margin. Scrolling the wrong chart is worse than not scrolling.
```

And append this line to the end of the `RECORDING DISCOVERIES:` block:

```
Scrolling moves rows OFF the screen as well as on, and you are never shown an earlier screenshot again. Record what you can currently read as a "discovery" on the SAME turn that you scroll, or the value is gone.
```

- [ ] **Step 5: Render scrolls in the history**

In `describeActionForHistory`, change the first line. Replace:

```js
function describeActionForHistory(h) {
  if (h.type === "click") return `(${h.nx?.toFixed(2)},${h.ny?.toFixed(2)})`;
```

with:

```js
function describeActionForHistory(h) {
  if (h.type === "scroll") return `${h.direction} (${h.nx?.toFixed(2)},${h.ny?.toFixed(2)})`;
  if (h.type === "click") return `(${h.nx?.toFixed(2)},${h.ny?.toFixed(2)})`;
```

Then make the changed/no-change outcome wording apply to scrolls too, since "did it move" is what the model needs. In `formatHistoryLine`, replace:

```js
  const outcome = h.type === "click" ? clickOutcome(h) : h.status;
```

with:

```js
  const outcome = h.type === "click" || h.type === "scroll" ? clickOutcome(h) : h.status;
```

- [ ] **Step 6: Extend the mode gate to reject scrolls outside pixel mode**

In `getNextAction`, replace:

```js
    const result = StepResponseSchema.safeParse(parsed);
    if (result.success && !((config.actuationMode ?? "pixel") !== "pixel" && result.data.action.type === "click")) {
```

with:

```js
    const result = StepResponseSchema.safeParse(parsed);
    const isPixelOnlyAction =
      result.success && (result.data.action.type === "click" || result.data.action.type === "scroll");
    if (result.success && !((config.actuationMode ?? "pixel") !== "pixel" && isPixelOnlyAction)) {
```

And update the feedback string just below it. Replace:

```js
    feedback = result.success
      ? `The "click" action is not available in this mode. Use one of the provided action types.`
```

with:

```js
    feedback = result.success
      ? `The "click" and "scroll" actions are not available in this mode. Use one of the provided action types.`
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS. If `api mode prompt never mentions scrolling` fails, the added rule text leaked into the shared `SYSTEM_TEMPLATE` instead of `PIXEL_SYSTEM_TEMPLATE` — check which template was edited.

- [ ] **Step 8: Commit**

```bash
git add backend/src/vlmClient.js backend/test/prompt.test.js
git commit -m "Offer the scroll action in the pixel prompt only"
```

---

### Task 7: Show the scroll in the live view

Without this the one action whose entire purpose is "the view moved" is the only action with no on-screen explanation.

**Files:**
- Modify: `frontend/src/screens/Watch/Stage.jsx:100-118`

**Interfaces:**
- Consumes: `overlay.scroll_point = {nx, ny, direction, target}` from Task 5.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Render the scroll point as a ring with a direction arrow**

In `frontend/src/screens/Watch/Stage.jsx`, immediately after the `{overlay?.click_point && ( ... )}` block and before the closing `</svg>`:

```jsx
                  {overlay?.scroll_point && (
                    <g className="text-teal">
                      <circle
                        cx={overlay.scroll_point.nx * naturalSize.w}
                        cy={overlay.scroll_point.ny * naturalSize.h}
                        r={Math.max(14, naturalSize.w * 0.016)}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={Math.max(2, naturalSize.w * 0.002)}
                        strokeDasharray={`${Math.max(4, naturalSize.w * 0.005)} ${Math.max(3, naturalSize.w * 0.004)}`}
                      />
                      <path
                        d={(() => {
                          const x = overlay.scroll_point.nx * naturalSize.w;
                          const y = overlay.scroll_point.ny * naturalSize.h;
                          const len = Math.max(10, naturalSize.w * 0.011);
                          const head = Math.max(4, naturalSize.w * 0.004);
                          const dir = overlay.scroll_point.direction === "up" ? -1 : 1;
                          const tip = y + dir * len;
                          return `M ${x} ${y - dir * len} L ${x} ${tip} M ${x - head} ${tip - dir * head} L ${x} ${tip} L ${x + head} ${tip - dir * head}`;
                        })()}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={Math.max(2, naturalSize.w * 0.0025)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  )}
```

The dashed ring distinguishes a scroll from a click's solid ring at a glance; the arrow shows which way.

- [ ] **Step 2: Verify it renders**

Start the frontend with the preview tool (`preview_start({name: "frontend"})`), open a completed session from the History screen that contains a scroll step, and confirm the dashed ring and arrow appear over the frame at the scrolled pane. Check `read_console_messages` for React warnings.

If no session with a scroll exists yet, defer this verification to Task 9 Step 3 and note that in the commit message.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens/Watch/Stage.jsx
git commit -m "Mark a scroll step in the live view with a dashed ring and direction arrow"
```

---

### Task 8: Settle-gate regression test for the scroll path

A scroll must not pay the bridge-event grace window. This is the cheapest guard against someone "consistently" adding `expectBridgeEvent: true` to the scroll branch later.

**Files:**
- Test: `backend/test/settleDecision.test.js`

**Interfaces:**
- Consumes: `settleDecision` from `backend/src/perception.js` (unchanged by this plan).
- Produces: nothing.

- [ ] **Step 1: Write the test**

Append to `backend/test/settleDecision.test.js`:

```js
test("a scroll settles on stable pixels without waiting out the event grace window", () => {
  // A scroll is a local re-render: no FilterChanged/ParameterChanged/TabSwitched
  // ever arrives, so it must take the !expectBridgeEvent path. Passing
  // expectBridgeEvent:true would burn the full eventGraceMs on EVERY scroll.
  const decision = settleDecision({
    pixelsStable: true,
    expectBridgeEvent: false,
    sawEvent: false,
    msSinceLastEvent: null,
    elapsedMs: 900,
    eventQuietMs: 700,
    eventGraceMs: 4500,
  });
  assert.equal(decision, "settled");
});

test("REGRESSION: the same scroll would stall if it demanded a bridge event", () => {
  // Documents the cost of getting it wrong, so the scroll branch's missing
  // expectBridgeEvent reads as deliberate rather than forgotten.
  const decision = settleDecision({
    pixelsStable: true,
    expectBridgeEvent: true,
    sawEvent: false,
    msSinceLastEvent: null,
    elapsedMs: 900,
    eventQuietMs: 700,
    eventGraceMs: 4500,
  });
  assert.equal(decision, "wait");
});
```

`settleDecision` is already imported at the top of that file (`import { settleDecision } from "../src/perception.js";`), so no import change is needed.

- [ ] **Step 2: Run the tests**

```bash
npm test
```

Expected: PASS immediately — `settleDecision` is unchanged, so these document existing behaviour the scroll branch depends on.

- [ ] **Step 3: Commit**

```bash
git add backend/test/settleDecision.test.js
git commit -m "Pin the settle semantics the scroll path relies on"
```

---

### Task 9: Manual integration against the real dashboard

**Files:**
- None modified. This task produces evidence.

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: a confirmed working demo path, and the observed answer needed by Task 10's eval question.

- [ ] **Step 1: Start both processes**

Backend, from `backend/`:

```bash
npm run dev
```

Expected: a listening banner naming port 8990. A port diagnostic instead means the bind failed — see README → Troubleshooting.

Frontend: use the preview tool, `preview_start({name: "frontend"})`.

- [ ] **Step 2: Run the scroll question end to end**

Open the frontend, pick **Data Science Salaries (US)**, and ask:

> In the 'Percent Remote Roles vs. Company Size' chart, scroll down to the Remote Ratio value of 100 and report which Company Size makes up the largest share of that pie.

Watch the Watch screen. Expected: a `scroll` step whose badge reads `Scroll down: ...`, followed by a frame in which the `100` row is visible with its pie, then an answer. Record the answer.

- [ ] **Step 3: Confirm the trajectory and the overlay**

On that scroll step, confirm the dashed ring and downward arrow sit over the pie pane (Task 7). Confirm the persisted frame is the **pre-scroll** view, so the trajectory shows what the model was looking at when it decided to scroll.

- [ ] **Step 4: Check the logs for the failure modes this plan guards against**

```bash
curl -s http://127.0.0.1:8990/api/config > /dev/null
```

In the backend console for that run, confirm: no `settle_timeout` warning on the scroll step (it would mean the pixels-only gate is not settling), and no repeated `rejected_loop` scroll steps (which would mean the dead-scroll radius is wrong). Use `read_console_messages` and `read_network_requests` on the frontend for client-side errors.

- [ ] **Step 5: Exercise the dead-scroll guard deliberately**

Ask, on the same dashboard:

> Scroll down in the empty area on the far left of the dashboard, then tell me what you see.

Expected: one `ok` scroll step recorded with `changed: false`, the "either already scrolled to its end or has nothing scrollable in it" feedback in the next prompt, and **no** second scroll at a nearby point. If the agent scrolls a nearby point in the same empty region, `pixel.scrollDeadRadius` is too small — raise it and re-run.

- [ ] **Step 6: Exercise the click-then-scroll sequence on a long dropdown**

The salaries case is a worksheet pane. A filter dropdown's list is a different structure and needs its own check — it is also the case the pixel prompt's rule 2 (click to open, then act) combines with scrolling.

Paste this URL on the landing page (the browse form is deliberate — `normalizeTableauViewUrl` must rewrite it):

```
https://public.tableau.com/app/profile/soha.elghany/viz/worlddata_16751035927180/DASHBOARD
```

Then ask:

> Open the Select Country dropdown and tell me whether Zimbabwe is one of the available countries.

Measured 2026-08-10: that list holds ~172 rows in a 711px window (2903px of overflow), opens *upward* from its trigger, stays open through a wheel event, and `Zimbabwe` is its last entry. Expect a click to open it, one or more scroll steps, and an answer of yes. Confirm the dropdown does not close when scrolled.

- [ ] **Step 7: Check the hover highlight has not become a fake selection**

On the dropdown run, look at the frame *after* a scroll step. The row under the agent's cursor carries a grey highlight that persists, and on a dropdown that looks like a selected row. Confirm the model's answer and any recorded discovery do not claim a country is selected when only the real selection (shown in the filter card's own label) is. If the model does misread it, record it as a follow-up — do not fix it inside this plan.

- [ ] **Step 8: Confirm api mode still refuses to scroll**

Temporarily set `"actuationMode": "api"` in `backend/config.json`, restart the backend, and ask the Task 9 Step 2 question again. Expected: the agent operates filters by id and never emits a scroll; if it does, the response is rejected with `The "click" and "scroll" actions are not available in this mode.` Restore `"actuationMode": "pixel"` and restart before continuing. Do **not** commit the temporary change.

---

### Task 10: Eval question, docs, and the accuracy comparison

**Files:**
- Modify: `backend/eval/questions.json`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-09-discoveries-memory-design.md`

**Interfaces:**
- Consumes: the observed answer from Task 9 Step 2 and the baseline from Task 1.
- Produces: nothing.

- [ ] **Step 1: Replace the unanswerable eval question with a scored one**

In `backend/eval/questions.json`, replace the whole `salaries_remote` entry with:

```json
    {
      "id": "salaries_remote_100",
      "dashboard_url": "https://public.tableau.com/views/DataScienceSalariesintheUSDashboard/Dashboard1",
      "kind": "actuate",
      "question": "In the 'Percent Remote Roles vs. Company Size' chart, scroll down to the Remote Ratio value of 100 and report which Company Size makes up the largest share of that pie.",
      "scored": true,
      "expect": [{ "word": ["M", "Medium"] }],
      "expected_answer": "M (medium-sized companies)",
      "verified_on": "2026-08-10",
      "notes": "Replaces the old unscored salaries_remote, which asked for a description and was unanswerable because Remote Ratio's 100 row sits below the fold with no scroll action. Now scorable: the pane has 222px of hidden content and one scroll step reveals the 100 row with its pie. Truth read by eye from a clean post-scroll capture - orange dominates that pie, and orange is M in the Company Size legend. Uses the word form deliberately: a bare \"M\" is scored as a case-insensitive SUBSTRING and would match nearly any sentence. Re-verify against a fresh capture before trusting a failure here; this is a third-party workbook."
    }
```

**The `{"word": ...}` form is mandatory here, not stylistic.** `matchesExpect` in `backend/src/evalMatch.js` scores a bare string as a **case-insensitive substring**, so `"expect": ["M"]` reduces to `hay.includes("m")` and passes on almost any English answer — a question that always scores green and therefore measures nothing. `{"word": [...]}` uses a `\b`-anchored regex, and the `"Medium"` alternative is there because the model may well expand the legend's `M` rather than echo the letter.

**Before committing, confirm the value against reality.** `M` comes from reading a post-scroll capture on 2026-08-10; if Task 9 Step 2's answer disagrees, re-capture the pane and settle it by eye rather than trusting either the model or this plan.

- [ ] **Step 2: Record the new gotchas in CLAUDE.md**

In the non-obvious-gotchas list, add:

```markdown
- **A Tableau pane's `scrollTop` is always `0`, however far it has scrolled.** Tableau clips its scroll containers with `overflow-y: hidden` and re-renders the visible window rather than scrolling natively, so `scrollTop`, `PageDown` and any DOM read are useless as witnesses — judging a scroll by them produces a confident, wrong "the wheel does nothing" (it happened during the design probe). The pixel diff is the only ground truth: `computeChangedRegions` catches even a 40px scroll (2 regions, 0.52% frame diff), and gives a clean 0 both for a wheel that hits nothing and for a pane already at its end.
- **Moving the agent's cursor onto a pane leaves a highlight that does not go away.** Tableau highlights the row under the pointer, and the highlight **persists after the cursor moves away** (measured on the World Government Summit dashboard: cursor-parked vs cursor-moved-away is 0 changed regions, highlight present in both). So there is no "park the mouse somewhere harmless" fix. Two consequences: any post-action pixel diff must be baselined *after* the cursor is positioned, or the highlight appearing reads as a successful scroll on a pane that never moved; and on an open filter dropdown the highlighted row looks like a selected one in the next frame the model reads.
- **Never scroll a Tableau pane by writing `scrollTop` — the labels desynchronize from the marks.** A worksheet's row labels live in a *separate* scroll container (`div.tab-tvYLabel`) from its marks (`div.tvScrollContainer`); on the salaries pie pane they carry 221px and 222px of overflow respectively. Setting `scrollTop` on the marks container alone moves the pies while the labels stay put, rendering the **`50` pie next to the label `0`** — nothing errors, nothing looks broken, and the model banks a mislabeled number as a confirmed discovery. Only `page.mouse.wheel` goes through Tableau's own scroll path and keeps them in sync, which is why `scroll` is a wheel event and not a DOM write.
```

Also update the `actionSchema.js` row of the backend module map from `8 action types` to `9 action types`, adding `scroll` to the parenthesised list, and note in the same row that `scroll` — like `click` — is pixel-mode only.

- [ ] **Step 3: Close the deferral in the discoveries spec**

In `docs/superpowers/specs/2026-08-09-discoveries-memory-design.md`, under `## Deferred`, prefix the `scroll` paragraph with:

```markdown
**Resolved** by `2026-08-10-scroll-action-design.md` (implemented 2026-08-10).
```

- [ ] **Step 4: Re-run the eval and compare against the baseline**

From `backend/`:

```bash
npm run eval -- eval/questions.json
```

Compare the printed `Accuracy: n/m` against Task 1's baseline, and diff the per-question rows:

```bash
git diff --no-index eval/baseline-2026-08-10.csv eval/results.csv
```

Interpret it honestly. `salaries_remote_100` is **not** part of the accuracy comparison — it is a different question from the one in the baseline, so it is a standalone pass/fail. For every other question: this change added an action and two rules to `PIXEL_SYSTEM_TEMPLATE`, which perturbs the prompt for questions with nothing to scroll, so a single moved result is not automatically a regression. Treat a change as signal only if it reproduces on a second run, and investigate it before committing.

- [ ] **Step 5: Commit**

```bash
git add backend/eval/questions.json CLAUDE.md docs/superpowers/specs/2026-08-09-discoveries-memory-design.md
git commit -m "Score the Remote Ratio question now that scrolling reaches it"
```

- [ ] **Step 6: Report the outcome**

State the baseline accuracy, the new accuracy, whether `salaries_remote_100` passed, and any per-question movement with your judgement on whether it reproduced. If the eval could not run because the API quota was spent, say so plainly rather than reporting a partial run as a pass.

---

## Notes for the implementer

- **`direction: "up"` is speculative, not load-bearing.** No case in the spec needs it: the prompt tells the model to bank its readings *before* scrolling, and nothing tells it that it over-scrolled. It is in the schema and the guard key because it is nearly free and makes an over-scroll recoverable — but if a later change finds it unused, dropping it is a simplification rather than a regression. Do not build anything that depends on it.
- **`config.dashboards` is not a privileged category.** Nothing in this change may branch on whether a URL is in that list; scroll must work identically on a pasted or searched workbook.
- **The frozen-core files fail silently.** If you find yourself "tidying" `vlmClient.js`'s prompts or `orchestrator.js`'s loop beyond the steps above, stop — there is no test that will catch the regression, only the eval number.
- **`waitForSettle` returns `{settled, timedOut}` and does not throw.** Discarding the return value means screenshotting a still-painting dashboard.
- **Never take a clipped screenshot of the viz.** `screenshotViz` already shoots the whole viewport and crops; do not "optimize" it into `locator.screenshot()`, which makes the live view stutter.

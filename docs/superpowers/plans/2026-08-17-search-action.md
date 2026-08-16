# `search` Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenth action, `search`, that types into an open Tableau filter dropdown's search box and presses Enter, collapsing a 6172-value list to a handful of matching rows in one step.

**Architecture:** A coordinate-free pixel-mode action. The actuator verifies a text entry is focused (the box auto-focuses when the dropdown opens), then dispatches `Control+A`, the text, and `Enter` — no mouse involved, so no aiming pass and no stray-click risk. Success is judged by two witnesses: a trailing newline in the box means Enter was not intercepted and the search did not run; otherwise the post-action pixel diff must show at least `pixel.searchMinRegions` changed regions.

**Tech Stack:** Node ESM, zod, Playwright, `node:test`, React (Vite) for the one frontend touch.

**Spec:** `docs/superpowers/specs/2026-08-17-search-action-design.md` (commit `701de11`)

## Global Constraints

- Action name is **`search`**, never `type` — the union discriminates on `"type"`, so `{"type":"type"}` is unreadable in logs and prompts.
- `search` is **pixel-mode only**, exactly like `click` and `scroll`. The api-mode system template must never mention it; `prompt.test.js` asserts this and the api arm is the project's comparison arm.
- The action carries **no coordinates**. Do not add `nx`/`ny`, do not call `locateTarget` or `refineClickPoint`, do not extend `normalizeClickAction`.
- The actuator must dispatch **zero keystrokes** when no text entry is focused.
- Frozen-core files (`actionSchema.js`, `vlmClient.js`, `orchestrator.js`) fail *silently*. Task 1's baseline and Task 8's re-run are not optional.
- Run tests with `npm test` from `backend/`, never a bare `node --test`.
- Commit after every task. Stage only the files the task touched; never `git add -A`.

---

### Task 1: Baseline the eval and calibrate the two open measurements

The spec leaves two things as reasoning rather than measurement: that a search fires no bridge event (so the settle gate must not wait for one), and that `≥2` changed regions separates a search that ran from one that did not. Both are decided here, before any frozen-core edit.

**Files:**
- Create: `backend/eval/baseline-2026-08-17.csv` (copied output)
- Create: `scratchpad/calibrate-search.mjs` (throwaway, not committed)

- [ ] **Step 1: Record the pre-change eval baseline**

Start the backend first (`cd backend && npm run dev`), confirm it prints the listening banner rather than a port diagnostic, then in a second shell:

```bash
cd backend && npm run eval -- eval/questions.json
```

Expected: an `Accuracy: n/m` line and `eval/results.csv` written. Record the exact accuracy number — it is the denominator for Task 8.

- [ ] **Step 2: Save the baseline**

```bash
cd backend && cp eval/results.csv eval/baseline-2026-08-17.csv
```

- [ ] **Step 3: Write the calibration script**

Create `scratchpad/calibrate-search.mjs` (use the session scratchpad directory, not the repo):

```js
import { pathToFileURL } from "node:url";
import path from "node:path";

const BACKEND = "D:/NSU/10th semester/CSE499B.17/dashboard-agent/backend";
const OUT = process.env.SCRATCH ?? ".";
const perception = await import(pathToFileURL(path.join(BACKEND, "src/perception.js")).href);
const { launchBrowser, openSession, waitForSettle, screenshotViz, computeChangedRegions } = perception;

const HOST = "http://127.0.0.1:8990";
const URL = "https://public.tableau.com/views/NetflixMoviesandTVShowsDashboard_17065467710800/Netflix";
const SETTLE = { postActionWaitMs: 400, compareIntervalMs: 500, diffThresholdPct: 0.5,
                 timeoutMs: 12000, eventQuietMs: 700, eventGraceMs: 4500 };
const p = (n) => path.join(OUT, n);

const FOCUSED = () => {
  const el = document.activeElement;
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const editable = tag === "input" || tag === "textarea" ||
    el.getAttribute("role") === "textbox" || el.isContentEditable;
  return editable ? { tag, cls: (el.className?.toString?.() ?? "").slice(0, 60), value: el.value ?? "" } : null;
};

async function tf(page) {
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      if (!f.url().includes("public.tableau.com")) continue;
      try { if (await f.evaluate(() => !!document.querySelector(".QuickFilterPanel"))) return f; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error("no live tableau frame");
}

const results = [];
for (let run = 1; run <= 6; run++) {
  const browser = await launchBrowser();
  try {
    const { page } = await openSession(browser, HOST, URL, { firstLoadTimeoutMs: 90000 });
    await waitForSettle(page, SETTLE);
    const frame = await tf(page);
    const g = await frame.evaluate(() => {
      const panel = [...document.querySelectorAll(".QuickFilterPanel")]
        .find((el) => (el.textContent ?? "").includes("Filter Title"));
      const b = panel.querySelector(".tabComboBoxNameContainer").getBoundingClientRect();
      return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
    });
    let opened = false;
    for (let a = 1; a <= 8 && !opened; a++) {
      await page.mouse.move(g.cx, g.cy, { steps: 12 });
      await page.mouse.click(g.cx, g.cy);
      await waitForSettle(page, SETTLE);
      opened = !!(await frame.evaluate(FOCUSED));
    }
    if (!opened) { results.push({ run, error: "never opened" }); continue; }

    await screenshotViz(page, p(`cal-${run}-pre.png`));
    await page.keyboard.press("Control+A");
    await page.keyboard.type("American", { delay: 40 });
    await page.keyboard.press("Enter");
    const settle = await waitForSettle(page, SETTLE);           // pixels-only
    await screenshotViz(page, p(`cal-${run}-post.png`));
    const after = await frame.evaluate(FOCUSED);
    const regions = await computeChangedRegions(p(`cal-${run}-pre.png`), p(`cal-${run}-post.png`));
    results.push({
      run,
      sawBridgeEvent: settle.sawBridgeEvent,
      settleTimedOut: settle.timedOut,
      value: JSON.stringify(after?.value ?? null),
      newline: (after?.value ?? "").includes("\n"),
      regions: regions.length,
      areas: regions.map((r) => r.w * r.h),
    });
  } finally { await browser.close(); }
}
console.table(results);
```

- [ ] **Step 4: Run it and read the two answers**

```bash
node scratchpad/calibrate-search.mjs
```

Expected: 6 rows. Read off:
1. **`sawBridgeEvent`** — if it is `false` on every run, the spec's settle decision (pixels-only, no `expectBridgeEvent`) is confirmed. If any run is `true`, stop and revise the spec before continuing.
2. **`regions` split by `newline`** — rows with `newline: true` are searches that did NOT run; rows with `newline: false` did. If the two groups separate cleanly at 2 (failures ≤1, successes ≥2), keep `searchMinRegions: 2`. If they overlap, set `searchMinRegions` to a value that separates them, or — if no value separates them — **drop the region test entirely and rely on the newline check alone**, and note that in the spec's "Did the search run?" section.

- [ ] **Step 5: Record the outcome in the spec**

Edit `docs/superpowers/specs/2026-08-17-search-action-design.md`, replacing the "This is reasoning, not a measurement" paragraph under **Settle** and the "calibrated on two samples" paragraph under **Did the search run?** with the measured numbers.

- [ ] **Step 6: Commit**

```bash
git add backend/eval/baseline-2026-08-17.csv docs/superpowers/specs/2026-08-17-search-action-design.md
git commit -m "Baseline the eval and calibrate the search guard thresholds"
```

---

### Task 2: `SearchAction` in the schema

**Files:**
- Modify: `backend/src/actionSchema.js`
- Test: `backend/test/actionSchema.test.js`

**Interfaces:**
- Produces: `ActionSchema` accepts `{ type: "search", text: string, target?: string }`. Later tasks read `action.text` and `action.target`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/actionSchema.test.js`:

```js
// ---- search ---------------------------------------------------------------

test("valid search parses", () => {
  const r = ActionSchema.safeParse({
    type: "search", text: "American Horror Story", target: "the Title filter search box",
  });
  assert.ok(r.success);
});

test("search without optional target parses", () => {
  assert.ok(ActionSchema.safeParse({ type: "search", text: "Ed Sheeran" }).success);
});

test("empty search text is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "search", text: "" }).success, false);
});

test("over-long search text is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "search", text: "a".repeat(101) }).success, false);
});

test("a search carries no coordinates", () => {
  // Deliberate: the box auto-focuses, and a click 2% below its centre was
  // measured selecting a title and filtering the dashboard silently.
  const r = ActionSchema.safeParse({ type: "search", text: "x", nx: 0.5, ny: 0.5 });
  assert.ok(r.success, "an extra key is stripped, not fatal");
  assert.equal(r.data.nx, undefined, "nx must not survive into the validated action");
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test
```

Expected: FAIL — the five new tests error because `search` is not a member of the discriminated union.

- [ ] **Step 3: Add the variant**

In `backend/src/actionSchema.js`, after `ScrollAction`:

```js
// Coordinate-free on purpose. The filter dropdown's search box is focused the
// instant the list opens (measured 2026-08-17), so there is nothing to aim at -
// and aiming at it is actively dangerous: a click 2% of frame height below its
// centre selected a title and filtered the dashboard to a value the model had
// never read. No nx/ny means no aiming pass, so a search costs ONE VLM request
// where a pixel click costs two or three.
const SearchAction = z.object({
  type: z.literal("search"),
  text: z.string().min(1).max(100),
  target: z.string().optional(),
});
```

And add it to the union, after `ScrollAction`:

```js
export const ActionSchema = z.discriminatedUnion("type", [
  SetFilterAction,
  SetRangeFilterAction,
  SetParameterAction,
  SwitchSheetAction,
  ClickAction,
  ScrollAction,
  SearchAction,
  WaitAction,
  AnswerAction,
  FailAction,
]);
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/actionSchema.js backend/test/actionSchema.test.js
git commit -m "Add the search action to the action schema"
```

---

### Task 3: Actuator — focus check, then keystrokes

**Files:**
- Modify: `backend/src/actuator.js`
- Create: `backend/test/searchActuator.test.js`

**Interfaces:**
- Consumes: `ActionSchema`'s `{ type: "search", text, target? }` from Task 2.
- Produces:
  - `export async function findFocusedTextEntry(page)` → `{ frame, tag, cls, value } | null`
  - `executeAction` case `"search"` → `{ ok: true, text, submitted: boolean | null }` or `{ ok: false, error }`. `submitted === false` means Enter was not intercepted; `null` means the value could not be re-read. Task 5 consumes `submitted`.
  - `describeAction` returns `Search: "<text>"`.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/searchActuator.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { findFocusedTextEntry, executeActionWithTimeout, describeAction } from "../src/actuator.js";

// A fake page is enough: the browser-side work is one evaluate() per frame, so
// the canned return value stands in for whatever the real page would report.
const pageWith = (frameResults, keyboard) => ({
  frames: () => frameResults.map((r) => ({
    evaluate: async () => { if (r instanceof Error) throw r; return r; },
  })),
  keyboard,
});
const spyKeyboard = () => {
  const log = [];
  return { log, press: async (k) => log.push(k), type: async (t) => log.push(`type:${t}`) };
};

test("no focused text entry anywhere reports null", async () => {
  assert.equal(await findFocusedTextEntry(pageWith([null, null], spyKeyboard())), null);
});

test("a detached frame does not abort the search for the focused box", async () => {
  // The Tableau iframe detaches and reattaches during load; one bad frame must
  // not hide a good one.
  const page = pageWith([new Error("Frame has been detached"), { tag: "textarea", cls: "QueryBox", value: "" }], spyKeyboard());
  const found = await findFocusedTextEntry(page);
  assert.equal(found.cls, "QueryBox");
});

test("a search with nothing focused dispatches NO keystrokes", async () => {
  // The whole point of the focus check: keystrokes sent at an unfocused page go
  // to Tableau's own keyboard shortcuts, with no way to tell where they landed.
  const kb = spyKeyboard();
  const res = await executeActionWithTimeout(pageWith([null], kb), null, { type: "search", text: "x" }, 1000);
  assert.equal(res.ok, false);
  assert.match(res.error, /open the filter dropdown first/i);
  assert.deepEqual(kb.log, []);
});

test("a search selects all, types, and presses Enter in that order", async () => {
  // Control+A first so a second search REPLACES the previous term rather than
  // appending to it ("American" + "Horror" -> "AmericanHorror").
  const kb = spyKeyboard();
  const page = pageWith([{ tag: "textarea", cls: "QueryBox", value: "American" }], kb);
  const res = await executeActionWithTimeout(page, null, { type: "search", text: "American" }, 1000);
  assert.equal(res.ok, true);
  assert.deepEqual(kb.log, ["Control+A", "type:American", "Enter"]);
});

test("a trailing newline reports the search as not submitted", async () => {
  // Measured failure: Enter is not reliably intercepted by the widget, and when
  // it is not, it inserts a newline into the textarea and nothing filters.
  const page = pageWith([{ tag: "textarea", cls: "QueryBox", value: "American\n" }], spyKeyboard());
  const res = await executeActionWithTimeout(page, null, { type: "search", text: "American" }, 1000);
  assert.equal(res.ok, true);
  assert.equal(res.submitted, false);
});

test("describeAction labels a search with its text", () => {
  assert.equal(describeAction({ type: "search", text: "American Horror Story" }, null),
               'Search: "American Horror Story"');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test
```

Expected: FAIL — `findFocusedTextEntry` is not exported.

- [ ] **Step 3: Implement**

In `backend/src/actuator.js`, add near the top after `nearMatches`:

```js
// The focused text entry, searched across every frame because the search box
// lives inside the cross-origin Tableau iframe. Returns null when nothing
// editable has focus, which is the signal to reject a search WITHOUT typing.
//
// A frame can detach mid-iteration during load, so a throwing frame is skipped
// rather than fatal - observed repeatedly while probing.
export async function findFocusedTextEntry(page) {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const tag = el.tagName.toLowerCase();
        const editable =
          tag === "input" ||
          tag === "textarea" ||
          el.getAttribute("role") === "textbox" ||
          el.isContentEditable;
        if (!editable) return null;
        return { tag, cls: (el.className?.toString?.() ?? "").slice(0, 80), value: el.value ?? "" };
      });
      if (found) return { frame, ...found };
    } catch {
      // detached frame; try the next
    }
  }
  return null;
}
```

Add the `search` case to `executeAction`, after the `scroll` case:

```js
case "search": {
  // No mouse at all. The box is focused the instant the dropdown opens, so
  // aiming at it buys nothing and risks everything: a click 2% of frame height
  // below its centre was measured selecting a title and closing the list.
  const focused = await findFocusedTextEntry(page);
  if (!focused) {
    return {
      ok: false,
      error:
        "No text box is focused, so nothing was typed. Open the filter dropdown first - " +
        "its search box is focused automatically when the list opens.",
    };
  }
  // Control+A so a second search replaces the prior term instead of appending;
  // a no-op on an empty box.
  await page.keyboard.press("Control+A");
  await page.keyboard.type(action.text);
  // Enter is REQUIRED: typing alone provably does not filter the list (polled
  // 15s, 4241 rows unchanged). aria-label="Search (Enter)" is literal.
  await page.keyboard.press("Enter");

  // Did Enter actually submit? When the widget does not intercept it, Enter
  // inserts a newline into the textarea and nothing filters. Re-reading the
  // value is the exact witness for that; null means we could not tell, and the
  // caller falls back to the pixel diff.
  const after = await findFocusedTextEntry(page);
  const submitted = after ? !String(after.value ?? "").includes("\n") : null;
  return { ok: true, text: action.text, submitted };
}
```

Add to `describeAction`, after the `scroll` case:

```js
case "search":
  return `Search: ${JSON.stringify(action.text)}`;
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd backend && npm test
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/actuator.js backend/test/searchActuator.test.js
git commit -m "Execute a search by keystroke, guarded by a focus check"
```

---

### Task 4: Prompt and mode gate

**Files:**
- Modify: `backend/src/vlmClient.js`
- Test: `backend/test/prompt.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PIXEL_SYSTEM_TEMPLATE` offers `search`; `getNextAction` rejects `search` outside pixel mode; `formatHistoryLine` renders `#3 search "American" -> changed`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/prompt.test.js`:

```js
// ---- search (pixel mode only) ----------------------------------------------

test("pixel mode prompt offers the search action", () => {
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/"type":"search"/.test(systemText));
});

test("api mode prompt never mentions searching", () => {
  // The api arm is the comparison arm for the two grounding strategies; its
  // prompt must not drift, or the comparison stops meaning anything.
  const { systemText } = buildPrompt({ ...BASE, mode: "api", discoveries: "" });
  assert.ok(!/"type":"search"/.test(systemText));
  assert.ok(!/search/i.test(systemText));
});

test("the pixel prompt tells the model NOT to click the search box first", () => {
  // Measured: the box auto-focuses on open, and a near-miss click selects a
  // value outright. A model that clicks it first is one miss from a wrong answer.
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/focused automatically/i.test(systemText));
});

test("a search renders in the history with its text and outcome", () => {
  const line = _internal.formatHistoryLine({
    idx: 3, type: "search", text: "American", status: "ok", changed: true,
  });
  assert.equal(line, '#3 search "American" -> changed');
});

test("a search that did not filter says so, rather than reporting ok", () => {
  const line = _internal.formatHistoryLine({
    idx: 4, type: "search", text: "American", status: "ok", changed: false,
  });
  assert.equal(line, '#4 search "American" -> no change');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && npm test
```

Expected: FAIL on all five.

- [ ] **Step 3: Add the action to the pixel template**

In `backend/src/vlmClient.js`, inside `PIXEL_SYSTEM_TEMPLATE`, add one line to the action list, immediately after the two `scroll` examples:

```
- {"type":"search","text":"American Horror Story","target":"the Title filter search box"}
```

- [ ] **Step 4: Add the rule**

In the same template, after existing rule 8:

```
9. Some dropdown lists hold THOUSANDS of values and cannot be reached by scrolling at all. If you have opened a list and the value you want is not visible, use "search" instead of scrolling - it filters the list down to matching entries in one step. The list must already be OPEN; its search box is focused automatically when the list opens, so do NOT click the box first. After searching, read the narrowed list on the next screenshot and click the row you want.
```

- [ ] **Step 5: Render a search in the history**

In `describeActionForHistory`, add as the first branch:

```js
if (h.type === "search") return JSON.stringify(h.text ?? "");
```

In `clickOutcome`'s doc comment and in `formatHistoryLine`, extend the outcome rule to `search` — the model needs "did it filter", not "ok":

```js
  const outcome =
    h.type === "click" || h.type === "scroll" || h.type === "search"
      ? clickOutcome(h)
      : h.status;
```

- [ ] **Step 6: Extend the mode gate**

In `getNextAction`, widen `isPixelOnlyAction`:

```js
    // click, scroll and search are all pixel-mode only; api mode must reject any.
    const isPixelOnlyAction =
      result.success &&
      (result.data.action.type === "click" ||
        result.data.action.type === "scroll" ||
        result.data.action.type === "search");
```

And update the feedback string just below it:

```js
    feedback = result.success
      ? `The "click", "scroll" and "search" actions are not available in this mode. Use one of the provided action types.`
      : ...
```

- [ ] **Step 7: Run to verify they pass**

```bash
cd backend && npm test
```

Expected: PASS, all tests. If `api mode prompt never mentions searching` fails, the word "search" has leaked into `SYSTEM_TEMPLATE` — remove it there, not from the test.

- [ ] **Step 8: Commit**

```bash
git add backend/src/vlmClient.js backend/test/prompt.test.js
git commit -m "Offer the search action in the pixel prompt only"
```

---

### Task 5: Orchestrator branch and guards

**Files:**
- Modify: `backend/src/orchestrator.js`
- Modify: `backend/config.json`

**Interfaces:**
- Consumes: `executeActionWithTimeout(...)` → `{ ok, text, submitted }` from Task 3; `describeAction` from Task 3.
- Produces: history entries `{ idx, key, type: "search", status, text, changed }` consumed by Task 4's `formatHistoryLine`.

- [ ] **Step 1: Add the config key**

In `backend/config.json`, inside `"pixel"`, after `scrollDeadRadius` (use the value Task 1 calibrated; `2` if it confirmed the spec):

```json
    "searchMinRegions": 2
```

- [ ] **Step 2: Add the action key**

In `backend/src/orchestrator.js`, in `actionKey`, after the `scroll` case:

```js
    case "search":
      return `search:${action.text.toLowerCase()}`;
```

Note there is deliberately **no** change to the `dup` exemption list. `click` and `scroll` are exempt because repeating them is how the agent travels; repeating an identical search is a genuine no-op and should be rejected like a repeated `set_filter`.

- [ ] **Step 3: Read the threshold alongside the other pixel settings**

Beside `const scrollNotchPx = ...`:

```js
  // How many changed regions prove a search actually filtered the list. A
  // FAILED search still echoes its own text and scores 1 region (one 86x53
  // grid cell, the differ's minimum unit), so zero-vs-nonzero cannot be the
  // test here the way it is for click and scroll.
  const searchMinRegions = config.pixel?.searchMinRegions ?? 2;
```

- [ ] **Step 4: Add the branch**

In `backend/src/orchestrator.js`, immediately after the closing brace of the `if (action.type === "scroll") { ... }` block and before `const resolved = tracker.resolve(action.target_id);`:

```js
    if (action.type === "search") {
      if (!isPixelMode) {
        // Belt-and-suspenders: a search can only be produced in pixel mode.
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: "search is only valid in pixel actuation mode",
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: search not allowed", type: "search" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("This mode does not support search actions. Use the provided action types.");
        history.push({ idx, key, type: "search", status: "rejected_target", text: action.text, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // No aiming pass and no cursor movement, so unlike scroll there is no
      // hover artifact to baseline around: the step's own frame is a clean
      // "before". No agent_cursor event either - there is no point to draw.
      const execResult = await executeActionWithTimeout(page, null, action, config.actionTimeoutMs);

      if (!execResult.ok) {
        persistAndEmit({
          idx, thought, action, status: "error", errorMsg: execResult.error,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Error: search", type: "search" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(execResult.error);
        history.push({ idx, key, type: "search", status: "error", text: action.text, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // NO expectBridgeEvent. The search re-renders the list locally and applies
      // no filter, so no filterchanged/parameterchanged/tabswitched can ever
      // arrive and demanding one burns the full eventGraceMs every time. Same
      // branch scroll takes.
      const settleResult = await waitForSettle(page, config.settleGate);
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      const postPath = framePath.replace(/\.png$/, "_post.png");
      // Fail OPEN on a capture error, matching the click and scroll branches: a
      // false negative here tells the model its search failed when it worked.
      let searchRan = true;
      try {
        await screenshotViz(page, postPath);
        const regions = await computeChangedRegions(framePath, postPath).catch(() => []);
        // Two witnesses. submitted === false is the exact signature of the
        // measured failure (Enter not intercepted -> newline in the box), and it
        // is decisive on its own. Otherwise fall back to the region count.
        searchRan = execResult.submitted === false ? false : regions.length >= searchMinRegions;
      } finally {
        fs.rmSync(postPath, { force: true });
      }

      persistAndEmit({
        idx, thought, action, status: searchRan ? "ok" : "ok_nochange",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "search" },
      });
      history.push({ idx, key, type: "search", status: "ok", text: action.text, changed: searchRan });

      if (!searchRan) {
        correctiveFeedback =
          `Your search for ${JSON.stringify(action.text)} did not filter the list - it is still showing the same entries. ` +
          `Do not repeat it. Click the value directly in the list if you can see it, or answer from what is visible.`;
        consecutiveNonProgress++;
      } else {
        // The list is now a handful of rows instead of thousands, so every guard
        // judgement made against the old view is stale.
        clearStaleGuards(guards);
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
      }
      prevFramePath = framePath;
      continue;
    }
```

- [ ] **Step 5: Verify nothing regressed**

```bash
cd backend && npm test
```

Expected: PASS, all tests. (This task adds no unit tests of its own — the branch needs a live Playwright page, and it is covered by Task 8's integration run.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/orchestrator.js backend/config.json
git commit -m "Run a search step and judge whether it filtered the list"
```

---

### Task 6: Feed shows a search that did not filter

**Files:**
- Modify: `frontend/src/screens/Watch/Feed.jsx:135-147`

- [ ] **Step 1: Extend the `ok_nochange` explanation**

In `Feed.jsx`, the `status === "ok_nochange"` branch currently forks on `scroll` vs everything-else. Replace the `explain` assignment with a three-way fork:

```js
    const point = formatPoint(step.action);
    if (step.action?.type === "search") {
      // No coordinates to show - a search has no point on screen.
      explain = "no effect — the search did not filter the list";
    } else if (step.action?.type === "scroll") {
      explain = `no effect${point ? ` ${point}` : ""} — nothing there scrolled, or it is already at its end`;
    } else {
      explain = `no effect${point ? ` ${point}` : ""} — the click missed, or the control is not on screen`;
    }
```

- [ ] **Step 2: Verify in the running app**

Start the frontend with the preview tool (`preview_start({name: "frontend"})`) and confirm the Watch screen still renders a trajectory without console errors. There is no `Stage.jsx` change — a search has no coordinates, so there is no overlay ring to draw.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens/Watch/Feed.jsx
git commit -m "Explain a search that did not filter the list"
```

---

### Task 7: Add the eval question

**Files:**
- Modify: `backend/eval/questions.json`

- [ ] **Step 1: Verify the ground truth by hand, first**

Do not take the number from this plan. Open the dashboard, set the Title filter to `American Horror Story`, and read the `Duration` KPI off a clean capture. `CLAUDE.md` records that the real-world figure (9 seasons) and the dashboard's figure (8) disagree — which is exactly the trap this question exists to catch, so a plausible-looking wrong answer is the expected failure mode.

- [ ] **Step 2: Add the question**

Append to the `questions` array in `backend/eval/questions.json`, using the duration you just read:

```json
    {
      "id": "netflix_search_title",
      "dashboard_url": "https://public.tableau.com/views/NetflixMoviesandTVShowsDashboard_17065467710800/Netflix",
      "kind": "act",
      "question": "Use the Title filter to select 'American Horror Story', then report the Duration shown for it.",
      "scored": true,
      "expect": ["8 season"],
      "expected_answer": "8 Seasons",
      "notes": "Only answerable via the search action: the Title list holds 6172 values over 101784px, about 339 scroll notches against a 15-step budget. Ground truth re-read by eye 2026-08-17. The real-world figure is 9 seasons and the dashboard says 8, so an answer of 9 means the model used remembered knowledge rather than reading the screen. Pixel-mode only - api mode can set this filter directly, so this is NOT cross-arm comparable."
    }
```

- [ ] **Step 3: Update `verified_on`**

Change the top-level `"verified_on"` to `"2026-08-17"` only if you re-verified the other questions too; otherwise leave it and rely on the per-question note.

- [ ] **Step 4: Commit**

```bash
git add backend/eval/questions.json
git commit -m "Add a Netflix question that only the search action can answer"
```

---

### Task 8: Integration, eval comparison, and docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the known-good integration case**

With both processes running, open `:5173`, pick **Netflix Movies & TV Shows**, and ask:

> What is the duration of American Horror Story?

Expected trajectory: `click` (open the Title dropdown) → `search` → `click` (the row) → `answer` **8 Seasons**. Watch for:
- The opening click may take more than one attempt — synthetic clicks open this combobox intermittently (opened on click 1, 2 and 3 across probe runs, and not at all in one). That is pre-existing, not a regression from this change.
- The `search` step should show a green tick, not a gold `!`. A gold `!` means the guard judged it as not having filtered — check whether the list actually narrowed in the frame before assuming the guard is wrong.

- [ ] **Step 2: Run the negative case**

Ask a question that makes the model search without opening a list first, or stop a run mid-way and confirm: a `search` issued with no dropdown open is rejected with "No text box is focused", and the step is an `error` with no keystrokes dispatched — not a wasted settle cycle.

- [ ] **Step 3: Re-run the eval and compare**

```bash
cd backend && npm run eval -- eval/questions.json
```

Compare against `eval/baseline-2026-08-17.csv` from Task 1. **Note the new question changes the denominator** — compare the *shared* questions, not the totals.

Adding an action and a rule changes the prompt for every question, including those with nothing to search, so unrelated results can move without anything being broken. Treat a change as signal only if it reproduces on a second run.

- [ ] **Step 4: Update `CLAUDE.md`**

Three edits:

1. In the backend module map, `actionSchema.js` row: change "9 action types" to "10 action types", add `search` to the list, and extend the pixel-mode note to "`click`, `scroll` and `search` are **pixel-mode only**".
2. In the same row, note that `search` carries no coordinates.
3. Add to the gotchas list:

```markdown
- **A Tableau filter search box needs ENTER, and Enter is not reliably intercepted.** The box is a `<textarea class="QueryBox">` (`aria-label="Search (Enter)"`) that appears only once the dropdown is open, and it is **focused the instant the list opens** — so `search` needs no click, and must not take one: a click 2% of frame height below its centre selected the title `American Anarchist` and filtered the dashboard to a value the model never read. Typing alone provably does nothing (polled 15s: 4241 rows unchanged, `scrollTop` 0, `scrollHeight` 101784 unchanged); Enter collapses the list from 6172 values to 25. But the same Enter sometimes inserts a **newline** into the textarea instead of submitting, and nothing filters — which is why `executeAction` re-reads the value and reports `submitted: false` on a trailing `\n`. The pixel diff alone cannot catch it: a *failed* search still echoes its text and scores 1 changed region (one 86×53 grid cell, the differ's minimum), against 3 for a successful one.
- **Tableau's DOM is not a witness for a filter list, in the same way `scrollTop` is not one for a pane.** After a successful search `[role='listbox']` goes `null` and a naive item count reads **0** while 25 rows are plainly on screen. An early draft of the search spec concluded "Enter does nothing" from exactly that reading, and only a screenshot corrected it. Measure the pixels; confirm against a capture.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the search action and the two gotchas behind it"
```

---

## Self-Review

**Spec coverage.** Action shape → Task 2. Actuator (focus check, Ctrl+A, type, Enter) → Task 3. Settle → Task 5 step 4, with the open measurement resolved in Task 1. Both success witnesses → Task 3 (`submitted`) and Task 5 (`searchMinRegions`). Loop guard and `clearStaleGuards` → Task 5. Mode gate → Task 4. Prompt → Task 4. Live view → Task 6. Eval question → Task 7. Files-touched list, testing and verification → Tasks 2–8. `CLAUDE.md` → Task 8. The spec's two Deferred items stay deferred and no task implements them.

**Type consistency.** `findFocusedTextEntry` is the name in Task 3's implementation, its export, and its tests. `execResult.submitted` is produced in Task 3 and consumed in Task 5 with the same tri-state (`true` / `false` / `null`). `searchMinRegions` is the config key in Task 5 step 1 and the variable in step 3. History entries carry `text` in Task 5 and are read as `h.text` in Task 4's `describeActionForHistory`.

**One deliberate ordering note.** Task 4 renders `search` history lines before Task 5 ever produces one; the tests in Task 4 construct the entry literally, so they pass independently of Task 5.

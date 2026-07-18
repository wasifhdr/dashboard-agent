# Pixel-Clicking Actuation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a config-selectable "pixel" actuation mode in which a hosted VLM operates the Tableau dashboard by clicking screen coordinates (with a visible synthetic cursor in the live view), coexisting with today's Embedding-API actuation as a separate profile.

**Architecture:** A `config.actuationMode` flag selects between `"api"` (unchanged) and `"pixel"`. In pixel mode, `vlmClient` talks to a hosted OpenAI-compatible endpoint (CraftX / Qwen3-VL) with a Bearer key read from a root `.env`; the model emits a `click{nx,ny}` action; the actuator maps the normalized point to page pixels and dispatches `page.mouse` (the same browser-level mechanism the live-takeover subsystem already uses); a synthetic cursor is broadcast to the live view and a click marker is drawn in replay.

**Tech Stack:** Node ESM, Express, Playwright, `zod`, `sharp`/`pixelmatch`, `better-sqlite3`, `ws`; Vite + React + Tailwind frontend; `dotenv` (new); Node's built-in `node:test` for backend unit tests (new — the repo currently has no test harness).

## Global Constraints

- **Frozen agent core** (`CLAUDE.md`): `vlmClient.js`, `actionSchema.js`, `actuator.js`, `perception.js`, `orchestrator.js`, and `eval/` sets are frozen. This plan edits four of them (`vlmClient.js`, `actionSchema.js`, `actuator.js`, `orchestrator.js`); every edit MUST be gated so `actuationMode:"api"` behavior is byte-for-byte unchanged. `perception.js`, `inventory.js`, and the `eval/` question sets are NOT modified.
- **API-mode default:** `config.actuationMode` defaults to `"api"` when absent. Read it everywhere as `config.actuationMode ?? "api"`.
- **Secrets:** the API key value never appears in `config.json`, code, logs, or git. Only the env-var *name* (`vlmApiKeyEnv`) is stored in config. `.env` is already git-ignored (root `.gitignore` lists `.env`).
- **Viz selector:** the Tableau element id is `agentViz`; the Playwright selector is `tableau-viz#agentViz` (NOT `#viz` — Tableau's internal iframe reuses `id="viz"`).
- **Coordinate contract:** `nx, ny ∈ [0,1]` are fractions of the **viz image** (the `screenshotViz` element screenshot), `(0,0)` = top-left, `(1,1)` = bottom-right. This matches the existing live-input contract in `conversationRuntime.dispatchInput`.
- **Provider (fill-in):** endpoint `https://api.craftx.corecraftsolutions.com/api`, model `Qwen3 VL 30B A3B Instruct`, key env var `CRAFTX_API_KEY`. The completions URL is `${endpoint}/v1/chat/completions`.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Run backend commands from `backend/`.** Windows + PowerShell primary; the `node --test` and `npm` commands below are shell-agnostic.

---

## File Structure

**Created**
- `backend/src/env.js` — loads the root `.env` via dotenv (imported first by every entry point).
- `backend/test/vlmTarget.test.js` — unit tests for endpoint/auth resolution.
- `backend/test/actionSchema.test.js` — unit tests for the `click` action variant.
- `backend/test/coords.test.js` — unit tests for the `nx,ny → page-pixel` transform.
- `backend/test/prompt.test.js` — unit tests for the pixel-mode prompt selection.
- `backend/test/cursorMessage.test.js` — unit test for the cursor WS message builder.

**Modified**
- `backend/package.json` — add `dotenv` dep + `"test": "node --test"` script.
- `backend/config.json` — add `actuationMode` + `pixel` sub-object.
- `backend/src/vlmClient.js` [frozen] — endpoint/auth resolution, pixel prompt.
- `backend/src/actionSchema.js` [frozen] — `ClickAction` variant.
- `backend/src/actuator.js` [frozen] — coord transform + `click` execution + `describeAction`.
- `backend/src/orchestrator.js` [frozen] — pixel-mode routing, loop-guard exemption, cursor events, click-point persistence.
- `backend/src/conversationRuntime.js` — `broadcastCursor` method + `cursorMessage` builder.
- `backend/src/server.js` — forward `agent_cursor` events onto the live WS.
- `backend/run.js`, `backend/eval.js` — import `env.js` first.
- `frontend/src/api.js` — parse a `cursor` WS message.
- `frontend/src/screens/Watch/useLiveChannel.js` — expose live cursor state.
- `frontend/src/screens/Watch/LiveStage.jsx` — render the synthetic cursor.
- `frontend/src/screens/Watch/Watch.jsx` — thread the cursor prop.
- `frontend/src/screens/Watch/Stage.jsx` — render the replay click marker.
- `README.md` — document the pixel mode + data-egress note.

---

### Task 1: Env loading + provider endpoint/auth resolution

**Files:**
- Create: `backend/src/env.js`
- Modify: `backend/package.json` (deps + test script)
- Modify: `backend/src/vlmClient.js` (endpoint/auth resolution; frozen, gated)
- Modify: `backend/src/server.js:14-18`, `backend/run.js:1-11`, `backend/eval.js:1-16` (import env.js first)
- Test: `backend/test/vlmTarget.test.js`

**Interfaces:**
- Produces: `resolveVlmTarget(config) -> { url: string, modelName: string, apiKeyEnv: string | null }` exported from `vlmClient.js` via the `_internal` object.
- Produces: `authHeaders(apiKeyEnv, env) -> Record<string,string>` exported via `_internal` (returns `{}` when `apiKeyEnv` is falsy or the env var is unset/empty; otherwise `{ Authorization: "Bearer <value>" }`).
- Consumes (later tasks): pixel target resolution uses `config.pixel` (added in Task 9), so `resolveVlmTarget` must read `config.pixel?.vlmEndpoint` etc. defensively (optional chaining) — the fields may be absent until Task 9 lands.

- [ ] **Step 1: Add the dotenv dependency and test script**

Edit `backend/package.json` — add `"dotenv": "^16.4.5"` to `dependencies` and `"test": "node --test"` to `scripts`. Then install:

Run: `npm install --prefix backend`
Expected: `dotenv` appears under `node_modules`; no errors.

- [ ] **Step 2: Create the env loader**

Create `backend/src/env.js`:

```js
// Loads the project-root .env (one level above backend/) exactly once, before
// any module reads process.env. Imported first by every entry point
// (server.js, run.js, eval.js). Safe if .env is absent — dotenv silently
// no-ops. The key VALUE is never logged; only presence matters downstream.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/env.js -> ../../ == project root (dashboard-agent/)
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
```

- [ ] **Step 3: Write the failing test for target/auth resolution**

Create `backend/test/vlmTarget.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { resolveVlmTarget, authHeaders } = _internal;

test("api mode resolves to llamaEndpoint completions URL, no key", () => {
  const cfg = { llamaEndpoint: "http://127.0.0.1:8080", modelName: "local" };
  const t = resolveVlmTarget(cfg);
  assert.equal(t.url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(t.modelName, "local");
  assert.equal(t.apiKeyEnv, null);
});

test("pixel mode resolves to the pixel endpoint + key env name", () => {
  const cfg = {
    actuationMode: "pixel",
    llamaEndpoint: "http://127.0.0.1:8080",
    modelName: "local",
    pixel: {
      vlmEndpoint: "https://api.craftx.corecraftsolutions.com/api",
      modelName: "Qwen3 VL 30B A3B Instruct",
      vlmApiKeyEnv: "CRAFTX_API_KEY",
    },
  };
  const t = resolveVlmTarget(cfg);
  assert.equal(t.url, "https://api.craftx.corecraftsolutions.com/api/v1/chat/completions");
  assert.equal(t.modelName, "Qwen3 VL 30B A3B Instruct");
  assert.equal(t.apiKeyEnv, "CRAFTX_API_KEY");
});

test("authHeaders returns {} without a key, Bearer with one", () => {
  assert.deepEqual(authHeaders(null, {}), {});
  assert.deepEqual(authHeaders("CRAFTX_API_KEY", {}), {});
  assert.deepEqual(authHeaders("CRAFTX_API_KEY", { CRAFTX_API_KEY: "" }), {});
  assert.deepEqual(authHeaders("CRAFTX_API_KEY", { CRAFTX_API_KEY: "sk-x" }), {
    Authorization: "Bearer sk-x",
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test test/vlmTarget.test.js` (from `backend/`)
Expected: FAIL — `resolveVlmTarget`/`authHeaders` are not exported yet.

- [ ] **Step 5: Implement resolution helpers in vlmClient.js and wire callVlm**

In `backend/src/vlmClient.js`, add these helpers above `callVlm`:

```js
// --- provider target resolution (pixel mode adds a hosted endpoint) --------

// Returns the completions URL, model name, and (optional) API-key env-var NAME
// for the active actuation mode. In "api" mode this is the local llama-server
// with no auth — identical to the pre-change behavior. In "pixel" mode it is
// the hosted OpenAI-compatible endpoint from config.pixel.
function resolveVlmTarget(config) {
  const mode = config.actuationMode ?? "api";
  if (mode === "pixel" && config.pixel?.vlmEndpoint) {
    return {
      url: `${config.pixel.vlmEndpoint}/v1/chat/completions`,
      modelName: config.pixel.modelName ?? config.modelName,
      apiKeyEnv: config.pixel.vlmApiKeyEnv ?? null,
    };
  }
  return {
    url: `${config.llamaEndpoint}/v1/chat/completions`,
    modelName: config.modelName,
    apiKeyEnv: null,
  };
}

// Builds the Authorization header from an env-var NAME (never a literal key).
// Empty/absent env value -> no header (local mode, or a misconfigured key).
function authHeaders(apiKeyEnv, env) {
  const value = apiKeyEnv ? env[apiKeyEnv] : null;
  return value ? { Authorization: `Bearer ${value}` } : {};
}
```

Then change `callVlm` to use them. Replace the `payload.model`, the `fetch` URL, and the `headers` object:

```js
async function callVlm({ config, systemText, userText, imagePath }) {
  const imageDataUrl = await resizeImageToDataUrl(imagePath, config.imageLongSide);
  const target = resolveVlmTarget(config);

  const payload = {
    model: target.modelName,
    messages: [
      { role: "system", content: systemText },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 768,
  };

  if (config.promptStyle === "constrained_json") {
    payload.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.vlmCallTimeoutMs);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(target.apiKeyEnv, process.env) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`VLM endpoint error ${res.status}: ${bodyText.slice(0, 800)}`);
    }
    const json = JSON.parse(bodyText);
    return json?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}
```

Finally, extend the `_internal` export at the bottom of the file:

```js
export const _internal = { formatInventoryForPrompt, formatHistoryLine, extractLastJsonObject, buildPrompt, resolveVlmTarget, authHeaders };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/vlmTarget.test.js`
Expected: PASS (4 tests).

- [ ] **Step 7: Import env.js first in every entry point**

- In `backend/src/server.js`, add as the very first import (before `express`): `import "./env.js";`
- In `backend/run.js`, add as the very first line: `import "./src/env.js";`
- In `backend/eval.js`, add as the very first line: `import "./src/env.js";`

- [ ] **Step 8: Verify the backend still boots (API mode unchanged)**

Run (from `backend/`, no llama-server needed to just boot the server): `node -e "import('./src/vlmClient.js').then(()=>console.log('ok'))"`
Expected: prints `ok` (module loads, dotenv resolved, no crash).

- [ ] **Step 9: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/env.js backend/src/vlmClient.js backend/src/server.js backend/run.js backend/eval.js backend/test/vlmTarget.test.js
git commit -m "$(cat <<'EOF'
Add env loading + provider endpoint/auth resolution for pixel mode

vlmClient resolves the completions URL, model, and Bearer auth from
config (api mode = local llama-server, no auth; pixel mode = hosted
OpenAI-compatible endpoint with key read from root .env by name).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `click` action schema variant

**Files:**
- Modify: `backend/src/actionSchema.js:47-55` (add variant to the union)
- Test: `backend/test/actionSchema.test.js`

**Interfaces:**
- Produces: the `ActionSchema` discriminated union accepts `{ type:"click", nx:number[0,1], ny:number[0,1], target?:string }`. `StepResponseSchema` (thought + action) accepts a click action.

- [ ] **Step 1: Write the failing test**

Create `backend/test/actionSchema.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { ActionSchema, StepResponseSchema } from "../src/actionSchema.js";

test("valid click parses", () => {
  const r = ActionSchema.safeParse({ type: "click", nx: 0.5, ny: 0.25, target: "ZRI tab" });
  assert.ok(r.success);
});

test("click without optional target parses", () => {
  const r = ActionSchema.safeParse({ type: "click", nx: 0, ny: 1 });
  assert.ok(r.success);
});

test("out-of-range coordinate is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "click", nx: 1.4, ny: 0.2 }).success, false);
  assert.equal(ActionSchema.safeParse({ type: "click", nx: 0.2, ny: -0.1 }).success, false);
});

test("existing api-mode actions still parse (regression)", () => {
  assert.ok(ActionSchema.safeParse({ type: "set_filter", target_id: "F1", values: ["Asia"] }).success);
  assert.ok(ActionSchema.safeParse({ type: "switch_sheet", target_id: "S2" }).success);
  assert.ok(StepResponseSchema.safeParse({ thought: "x", action: { type: "answer", answer: "42" } }).success);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/actionSchema.test.js`
Expected: FAIL — a `click` action is not in the union yet.

- [ ] **Step 3: Add the ClickAction variant**

In `backend/src/actionSchema.js`, add above the `ActionSchema` declaration:

```js
const ClickAction = z.object({
  type: z.literal("click"),
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  target: z.string().optional(),
});
```

Then add `ClickAction` to the `z.discriminatedUnion("type", [...])` array (append it after `SwitchSheetAction`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/actionSchema.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/actionSchema.js backend/test/actionSchema.test.js
git commit -m "$(cat <<'EOF'
Add click action variant to the action schema

Additive discriminated-union member {type:"click",nx,ny,target?} for
pixel mode; existing api-mode variants are unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Coordinate transform + `click` execution in the actuator

**Files:**
- Modify: `backend/src/actuator.js` (add transform, `click` case, `describeAction` case)
- Test: `backend/test/coords.test.js`

**Interfaces:**
- Consumes: the `click` action shape from Task 2.
- Produces: `vizPointToPagePixels(box, nx, ny) -> { px:number, py:number }` exported from `actuator.js`, where `box` is a Playwright bounding box `{ x, y, width, height }`.
- Produces: `executeAction` handles `action.type === "click"` (dispatches `page.mouse`), returning `{ ok:true, point:{ nx, ny, px, py } }` or `{ ok:false, error }`.
- Produces: `describeAction` returns `Click: <target ?? (nx, ny)>` for a click.

- [ ] **Step 1: Write the failing test for the transform**

Create `backend/test/coords.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { vizPointToPagePixels } from "../src/actuator.js";

test("maps normalized point into the viz bounding box", () => {
  const box = { x: 100, y: 50, width: 800, height: 400 };
  assert.deepEqual(vizPointToPagePixels(box, 0, 0), { px: 100, py: 50 });
  assert.deepEqual(vizPointToPagePixels(box, 1, 1), { px: 900, py: 450 });
  assert.deepEqual(vizPointToPagePixels(box, 0.5, 0.5), { px: 500, py: 250 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/coords.test.js`
Expected: FAIL — `vizPointToPagePixels` is not exported.

- [ ] **Step 3: Implement the transform, click case, and describeAction case**

In `backend/src/actuator.js`, add the viz selector constant near the top (mirroring `conversationRuntime.js` — `perception.js` is frozen and does not export it):

```js
// Must match id on <tableau-viz id="agentViz"> in public/host.html.
// Duplicated (not imported) because perception.js is frozen and does not
// export its VIZ_SELECTOR — same rationale as conversationRuntime.js.
const VIZ_SELECTOR = "tableau-viz#agentViz";

// Pure transform: a normalized [0,1] point over the viz image -> absolute page
// pixels, using the viz element's bounding box. Same math family as
// conversationRuntime.dispatchInput.
export function vizPointToPagePixels(box, nx, ny) {
  return { px: box.x + nx * box.width, py: box.y + ny * box.height };
}
```

Add a `click` case inside `executeAction`'s `switch` (before `default`):

```js
      case "click": {
        const box = await page.locator(VIZ_SELECTOR).boundingBox();
        if (!box || !box.width || !box.height) {
          return { ok: false, error: "Viz element not measurable right now (mid-transition); try again." };
        }
        const { px, py } = vizPointToPagePixels(box, action.nx, action.ny);
        await page.mouse.move(px, py, { steps: 12 });
        await page.mouse.click(px, py);
        return { ok: true, point: { nx: action.nx, ny: action.ny, px, py } };
      }
```

Add a `click` case inside `describeAction`'s `switch` (before `default`):

```js
    case "click":
      return `Click: ${action.target ?? `(${action.nx.toFixed(3)}, ${action.ny.toFixed(3)})`}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/coords.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add backend/src/actuator.js backend/test/coords.test.js
git commit -m "$(cat <<'EOF'
Add pixel click execution + coordinate transform to the actuator

Browser-level page.mouse click at a normalized viz point mapped
through the viz bounding box; describeAction renders the click.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Orchestrator pixel-mode routing, loop-guard exemption, cursor events, click-point persistence

**Files:**
- Modify: `backend/src/orchestrator.js` (loop routing for `click`)

**Interfaces:**
- Consumes: `click` schema (Task 2); `executeActionWithTimeout` + `describeAction` click handling (Task 3); `screenshotViz` + `computeChangedRegions` (existing, `perception.js`).
- Produces: `onEvent({ type:"agent_cursor", idx, nx, ny, phase })` with `phase` ∈ `"move" | "click"`, consumed by `server.js` (Task 6).
- Produces: persisted `overlay.click_point = { nx, ny, target }` on click steps, consumed by `Stage.jsx` (Task 8).

This task has no standalone unit test (the loop needs a live Playwright page); it is exercised by the pixel-mode verification in Task 10. Keep the diff minimal and gated.

- [ ] **Step 1: Exempt `click` from the exact-repeat loop guard**

In `backend/src/orchestrator.js`, find the duplicate check (currently `const dup = action.type !== "wait" ? history.find(...) : null;`) and change the condition so clicks are never treated as duplicates (a click's effect depends on current UI state):

```js
    const key = actionKey(action);
    const dup =
      action.type !== "wait" && action.type !== "click"
        ? history.find((h) => h.key === key && h.status === "ok")
        : null;
```

Also extend `actionKey` (top of file) with a coarse, telemetry-only click key (never used for rejection, but keeps history entries distinct):

```js
    case "click":
      return `click:${action.nx.toFixed(2)},${action.ny.toFixed(2)}`;
```

- [ ] **Step 2: Route `click` before the `target_id` resolution branch**

The existing loop resolves `action.target_id` via `tracker.resolve(...)` and rejects unknown ids. A click has no `target_id`, so it must be handled before that. Immediately after the `wait` handling block (right after `consecutiveWaits = 0;`) and BEFORE `const resolved = tracker.resolve(action.target_id);`, insert:

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
        history.push({ idx, key, type: "click", status: "rejected_target" });
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
        history.push({ idx, key, type: "click", status: "error" });
        prevFramePath = framePath;
        continue;
      }

      const settleResult = await waitForSettle(page, config.settleGate);
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      // Did the click visibly change anything? Diff a fresh post-click frame
      // against this step's pre-click frame. Used ONLY to drive corrective
      // feedback; the persisted frame stays the pre-action screenshot, matching
      // api-mode semantics (an action's visual effect appears in the NEXT frame).
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
      });
      // Attach the click point to the persisted overlay for the replay marker.
      // persistAndEmit builds overlay internally, so re-open the last step row
      // is avoided by threading click_point through a dedicated field:
      history.push({ idx, key, type: "click", status: "ok" });

      if (!clickChanged) {
        noDiffClicks++;
        if (noDiffClicks >= 2) {
          correctiveFeedback = withEscalation(
            "Your last click produced no visible change. Look carefully at the screenshot and aim your next click at the actual control (a tab, dropdown, or value).",
          );
        }
        consecutiveNonProgress++;
      } else {
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
      }
      prevFramePath = framePath;
      continue;
    }
```

- [ ] **Step 3: Thread `click_point` into the persisted overlay**

`persistAndEmit` currently builds `overlay = { action_badge, widget_bbox, changed_regions }`. Add an optional `clickPoint` parameter and include it. In the `persistAndEmit` signature add `clickPoint = null,` and change the overlay line to:

```js
    const overlay = { action_badge: actionBadge, widget_bbox: widgetBbox, changed_regions: changedRegions, click_point: clickPoint };
```

Then in the click branch's successful `persistAndEmit(...)` call (Step 2), add:

```js
        clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null },
```

- [ ] **Step 4: Declare the `noDiffClicks` counter**

Near the other loop counters (`let consecutiveWaits = 0;` etc., before the `while` loop), add:

```js
  let noDiffClicks = 0; // consecutive pixel clicks that produced no visible change
```

- [ ] **Step 5: Verify the module loads and API-mode unit tests still pass**

Run: `node -e "import('./src/orchestrator.js').then(()=>console.log('ok'))"` (from `backend/`)
Expected: prints `ok` (no syntax/reference errors).

Run: `node --test` (from `backend/`)
Expected: PASS — all existing unit tests (vlmTarget, actionSchema, coords) still green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/orchestrator.js
git commit -m "$(cat <<'EOF'
Route pixel clicks through the orchestrator loop

Click branch: cursor events, browser-level execution, settle, post-click
no-diff corrective feedback, click_point overlay; clicks are exempt from
the exact-repeat loop guard but keep the step budget and non-progress
escalation. Gated on actuationMode; api mode unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Pixel-mode system prompt

**Files:**
- Modify: `backend/src/vlmClient.js` (add pixel prompt + `mode` param to `buildPrompt`)
- Test: `backend/test/prompt.test.js`

**Interfaces:**
- Consumes: `config.actuationMode` (via `getNextAction`, which already receives `config`).
- Produces: `buildPrompt({ question, inventory, history, correctiveFeedback, mode })` selects the pixel system prompt when `mode === "pixel"`. Exposed through `_internal.buildPrompt`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/prompt.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const inventory = { sheets: [], filters: [], parameters: [] };

test("api mode prompt does not mention clicking", () => {
  const { systemText } = _internal.buildPrompt({ question: "q", inventory, history: [], mode: "api" });
  assert.ok(/set_filter/.test(systemText));
  assert.ok(!/"type":"click"/.test(systemText));
});

test("pixel mode prompt instructs coordinate clicks", () => {
  const { systemText } = _internal.buildPrompt({ question: "q", inventory, history: [], mode: "pixel" });
  assert.ok(/"type":"click"/.test(systemText));
  assert.ok(/nx/.test(systemText) && /ny/.test(systemText));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/prompt.test.js`
Expected: FAIL — `buildPrompt` ignores `mode` and never emits the click prompt.

- [ ] **Step 3: Add the pixel prompt and mode selection**

In `backend/src/vlmClient.js`, add a pixel system template next to `SYSTEM_TEMPLATE`:

```js
const PIXEL_SYSTEM_TEMPLATE = (question) => `You are an agent that answers a question about a live, interactive Tableau dashboard by OPERATING IT WITH MOUSE CLICKS, then answering.

QUESTION: "${question}"

On each turn you are shown:
- The current dashboard screenshot
- An inventory of the controls that exist (for reference — it tells you WHAT is there, but you must act by CLICKING, not by id)
- A short history of your previous actions and their outcomes

You interact ONLY by clicking. Emit a click as normalized fractions of the image: nx is the horizontal fraction (0 = left edge, 1 = right edge), ny is the vertical fraction (0 = top edge, 1 = bottom edge). Aim at the CENTER of the control you want.

Respond with STRICT JSON ONLY (no markdown, no commentary), matching exactly:
{"thought": "<= 2 sentences", "action": { ... }}

The "action" object must be exactly one of:
- {"type":"click","nx":0.42,"ny":0.13,"target":"ZRI tab"}
- {"type":"wait"}
- {"type":"answer","answer":"<final answer text>","confidence":0.8}
- {"type":"fail","reason":"<why this cannot be answered>"}

Rules:
1. Exactly one action per turn.
2. To operate a control that opens (a dropdown, a filter list), click it once, then WAIT for the next screenshot and click the value you want.
3. Prefer "answer" as soon as the screenshot shows everything needed.
4. If your previous click changed nothing, aim more precisely at the actual control next time.
5. Only use "wait" if the dashboard visibly appears to still be updating; never more than twice in a row.
6. Only use "fail" if the question is genuinely unanswerable from this dashboard after exploring it by clicking.`;
```

Change `buildPrompt` to take and use `mode`:

```js
function buildPrompt({ question, inventory, history, correctiveFeedback, mode = "api" }) {
  const systemText = mode === "pixel" ? PIXEL_SYSTEM_TEMPLATE(question) : SYSTEM_TEMPLATE(question);
  const historyText = history.length ? history.map(formatHistoryLine).join("\n") : "(no actions taken yet)";
  const invText = formatInventoryForPrompt(inventory);

  let userText = `CURRENT INVENTORY:\n${invText}\n\nHISTORY:\n${historyText}\n`;
  if (correctiveFeedback) {
    userText += `\nFEEDBACK ON YOUR LAST RESPONSE:\n${correctiveFeedback}\n`;
  }
  userText += `\nRespond with the JSON object now.`;

  return { systemText, userText };
}
```

Pass the mode through from `getNextAction`. In `getNextAction`, find the `buildPrompt({ question, inventory, history, correctiveFeedback: feedback })` call and change it to:

```js
    const { systemText, userText } = buildPrompt({ question, inventory, history, correctiveFeedback: feedback, mode: config.actuationMode ?? "api" });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/prompt.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/vlmClient.js backend/test/prompt.test.js
git commit -m "$(cat <<'EOF'
Add pixel-mode system prompt (click by normalized coordinates)

buildPrompt selects a click-based prompt when actuationMode is pixel;
inventory stays as reference context (soft parity). api-mode prompt
unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Broadcast the agent cursor onto the live WebSocket

**Files:**
- Modify: `backend/src/conversationRuntime.js` (add `broadcastCursor` + `cursorMessage`)
- Modify: `backend/src/server.js:280` (forward `agent_cursor` in the turn's `onEvent`)
- Test: `backend/test/cursorMessage.test.js`

**Interfaces:**
- Consumes: `onEvent({ type:"agent_cursor", idx, nx, ny, phase })` from the orchestrator (Task 4).
- Produces: `cursorMessage(nx, ny, phase) -> { type:"cursor", nx, ny, phase }` exported from `conversationRuntime.js`.
- Produces: a `broadcastCursor(nx, ny, phase)` method on the runtime object returned by `createRuntime`.
- Produces: a `{type:"cursor", nx, ny, phase}` WS message on the live channel, consumed by `api.js`/`useLiveChannel` (Task 7).

- [ ] **Step 1: Write the failing test for the message builder**

Create `backend/test/cursorMessage.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { cursorMessage } from "../src/conversationRuntime.js";

test("cursorMessage builds the WS payload", () => {
  assert.deepEqual(cursorMessage(0.25, 0.75, "move"), { type: "cursor", nx: 0.25, ny: 0.75, phase: "move" });
  assert.deepEqual(cursorMessage(0.5, 0.5, "click"), { type: "cursor", nx: 0.5, ny: 0.5, phase: "click" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cursorMessage.test.js`
Expected: FAIL — `cursorMessage` is not exported.

- [ ] **Step 3: Add the builder and the runtime method**

In `backend/src/conversationRuntime.js`, add a top-level export near the other module-level helpers (outside `createRuntime`):

```js
// WS payload for a synthetic agent cursor position (live view overlay).
export function cursorMessage(nx, ny, phase) {
  return { type: "cursor", nx, ny, phase };
}
```

Inside `createRuntime`, where the runtime object is assembled and returned (the object that already exposes `addClient`, `dispatchInput`, `setMode`, `close`, etc.), add a method:

```js
    broadcastCursor(nx, ny, phase) {
      // Fan the cursor position out to live watchers over the same channel as
      // frames/vizbox. broadcast() is the module-internal fan-out already used
      // for frame/lock messages.
      broadcast(cursorMessage(nx, ny, phase));
    },
```

(If the runtime object is built as an object literal, add the method there; if methods are attached to a `runtime` variable, attach it the same way as the neighbors. Match the surrounding style.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cursorMessage.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Forward `agent_cursor` events in the turn's onEvent (server.js)**

In `backend/src/server.js`, inside `startTurn`, change the `runSession` `onEvent` handler so cursor events go to the runtime instead of the SSE bus:

```js
    onEvent: (evt) => {
      if (evt.type === "agent_cursor") {
        activeRuntime.broadcastCursor(evt.nx, evt.ny, evt.phase);
        return;
      }
      adaptAndPublish(turnId, evt);
    },
```

- [ ] **Step 6: Verify modules load**

Run: `node -e "import('./src/conversationRuntime.js').then(()=>console.log('ok'))"` (from `backend/`)
Expected: prints `ok`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/conversationRuntime.js backend/src/server.js backend/test/cursorMessage.test.js
git commit -m "$(cat <<'EOF'
Broadcast the agent cursor over the live WebSocket

conversationRuntime gains broadcastCursor; server forwards the
orchestrator's agent_cursor events onto the live channel as
{type:"cursor",nx,ny,phase}.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Frontend — render the synthetic cursor in the live view

**Files:**
- Modify: `frontend/src/api.js:136-154` (parse `cursor` message)
- Modify: `frontend/src/screens/Watch/useLiveChannel.js` (cursor state)
- Modify: `frontend/src/screens/Watch/LiveStage.jsx` (render cursor)
- Modify: `frontend/src/screens/Watch/Watch.jsx` (thread the prop)

**Interfaces:**
- Consumes: the `{type:"cursor", nx, ny, phase}` WS message (Task 6).
- Produces: a `cursor` value (`{ nx, ny, phase } | null`) returned from `useLiveChannel` and rendered by `LiveStage`.

No unit test (no frontend test harness). Verified in the browser during Task 10.

- [ ] **Step 1: Parse the cursor message in api.js**

In `frontend/src/api.js`, add a case to the `switch (evt.type)` inside `openLiveChannel`'s `ws.onmessage`, alongside `frame`/`vizbox`/`lock`:

```js
      case "cursor":
        handlers.onCursor?.(evt.nx, evt.ny, evt.phase);
        break;
```

- [ ] **Step 2: Track cursor state in useLiveChannel**

In `frontend/src/screens/Watch/useLiveChannel.js`:

- Add state: `const [cursor, setCursor] = useState(null);`
- In the per-conversation reset block (where `setMode("idle")` etc. run), add `setCursor(null);`
- In the `connect()` handlers object, add:

```js
        onCursor: (nx, ny, phase) => {
          if (!disposed) setCursor({ nx, ny, phase });
        },
```

- In `onUnlock` (turn ended), also clear the cursor: add `setCursor(null);` next to `setMode("idle")`.
- Add `cursor` to the returned object: `return { liveFrameUrl, vizBox, viewport, mode, connected, closedReason, sendInput, cursor };`

- [ ] **Step 3: Render the cursor in LiveStage**

In `frontend/src/screens/Watch/LiveStage.jsx`:

- Add `cursor = null,` to the `LiveStage({ ... })` destructured props.
- Inside the `canCrop` branch, immediately after the `<img .../>` (and before `{interactive && <InputCaptureLayer .../>}`), add:

```jsx
                {mode === "agent" && cursor && (
                  <div
                    className="pointer-events-none absolute z-30 transition-all duration-200 ease-out"
                    style={{ left: `${cursor.nx * 100}%`, top: `${cursor.ny * 100}%`, transform: "translate(-2px, -2px)" }}
                  >
                    {/* pointer glyph */}
                    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                      <path d="M2 2 L2 16 L6 12 L9 19 L12 18 L9 11 L15 11 Z" fill="white" stroke="black" strokeWidth="1.2" />
                    </svg>
                    {/* click ripple */}
                    {cursor.phase === "click" && (
                      <span className="absolute -left-2 -top-2 block h-6 w-6 animate-ping rounded-full bg-teal/60" />
                    )}
                    <span className="absolute left-5 top-3 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      agent
                    </span>
                  </div>
                )}
```

- [ ] **Step 4: Thread the prop through Watch.jsx**

In `frontend/src/screens/Watch/Watch.jsx`, find where `useLiveChannel(...)` is destructured and where `<LiveStage ... />` is rendered. Add `cursor` to the destructure and pass `cursor={cursor}` to `<LiveStage>`. (Read the file to place these two additions next to the existing `mode`/`vizBox`/`sendInput` wiring.)

- [ ] **Step 5: Verify the frontend builds**

Run: `npm run build --prefix frontend`
Expected: build succeeds with no errors (Vite production build type-checks JSX).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.js frontend/src/screens/Watch/useLiveChannel.js frontend/src/screens/Watch/LiveStage.jsx frontend/src/screens/Watch/Watch.jsx
git commit -m "$(cat <<'EOF'
Render the synthetic agent cursor in the live view

useLiveChannel surfaces the {nx,ny,phase} cursor from the live WS;
LiveStage draws a labeled pointer + click ripple over the cropped viz
while the agent is driving.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Frontend — replay click marker

**Files:**
- Modify: `frontend/src/screens/Watch/Stage.jsx:89-108` (add click_point mark to the overlay SVG)

**Interfaces:**
- Consumes: `step.overlay.click_point = { nx, ny, target }` persisted by the orchestrator (Task 4). The overlay SVG uses `viewBox="0 0 naturalSize.w naturalSize.h"`, so the point is at `nx * naturalSize.w`, `ny * naturalSize.h`.

No unit test (no frontend test harness). Verified in the browser during Task 10.

- [ ] **Step 1: Draw the click marker**

In `frontend/src/screens/Watch/Stage.jsx`, inside the `<svg ...>` overlay block (after the `widget_bbox` `{overlay?.widget_bbox && (...)}` element, still inside the `<svg>`), add:

```jsx
                  {overlay?.click_point && (
                    <g>
                      <circle
                        cx={overlay.click_point.nx * naturalSize.w}
                        cy={overlay.click_point.ny * naturalSize.h}
                        r={Math.max(10, naturalSize.w * 0.012)}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={Math.max(2, naturalSize.w * 0.002)}
                        className="text-teal"
                      />
                      <circle
                        cx={overlay.click_point.nx * naturalSize.w}
                        cy={overlay.click_point.ny * naturalSize.h}
                        r={Math.max(3, naturalSize.w * 0.003)}
                        className="fill-teal"
                      />
                    </g>
                  )}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `npm run build --prefix frontend`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens/Watch/Stage.jsx
git commit -m "$(cat <<'EOF'
Draw click-point marker on replay frames

Renders overlay.click_point as a crosshair on the step frame using the
existing SVG overlay system (toggleable with the other overlays).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Pixel-mode config profile + README docs

**Files:**
- Modify: `backend/config.json` (add `actuationMode` + `pixel` sub-object)
- Modify: `README.md` (pixel mode section + data-egress note)

**Interfaces:**
- Produces: the `config.pixel` shape consumed by `resolveVlmTarget` (Task 1): `{ vlmEndpoint, modelName, vlmApiKeyEnv }`.

- [ ] **Step 1: Add the config fields (default stays api mode)**

In `backend/config.json`, add two top-level keys (place `actuationMode` near the top, `pixel` after `modelName`). Keep `actuationMode` at `"api"` so the default demo is unchanged:

```json
  "actuationMode": "api",
  "pixel": {
    "vlmEndpoint": "https://api.craftx.corecraftsolutions.com/api",
    "modelName": "Qwen3 VL 30B A3B Instruct",
    "vlmApiKeyEnv": "CRAFTX_API_KEY"
  },
```

- [ ] **Step 2: Confirm `.env` is git-ignored and the key var is present**

Run (from repo root): `git check-ignore .env && grep -q CRAFTX_API_KEY .env && echo "env ok"`
Expected: prints `.env` then `env ok` (the file is ignored and contains the key). If `env ok` does not print, add `CRAFTX_API_KEY=<key>` to the root `.env` (do NOT commit it).

- [ ] **Step 3: Document the mode in the README**

Add a "Pixel-clicking actuation mode" subsection to `README.md` covering:
- What it is: a config-selected mode where a hosted VLM operates the dashboard by clicking (visible cursor), vs. the default Embedding-API actuation.
- How to enable: set `config.actuationMode` to `"pixel"`; the `config.pixel` block points at the provider; put `CRAFTX_API_KEY=<key>` in the root `.env` (git-ignored).
- **Data-egress note (verbatim intent):** "In pixel mode, per-step dashboard screenshots are sent to the configured third-party VLM endpoint (CraftX), unlike the default local-only pipeline. The configured dashboards are Tableau Public (public data), so sensitivity is low; no credentials or personal data are sent."
- How to run the demo: enable pixel mode, start the three processes, ask the Zillow ZRI question, and watch the cursor operate the dashboard.

- [ ] **Step 4: Commit**

```bash
git add backend/config.json README.md
git commit -m "$(cat <<'EOF'
Add pixel-mode config profile and README docs

config.pixel points at the CraftX/Qwen3-VL endpoint; actuationMode
defaults to api. README documents enabling pixel mode and the
third-party screenshot egress trade-off.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Verification & frozen-core eval gate

**Files:** none (verification only). Requires the running services (llama-server for the API baseline, network + `CRAFTX_API_KEY` for pixel mode).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full backend unit suite passes**

Run: `node --test` (from `backend/`)
Expected: PASS — vlmTarget, actionSchema, coords, prompt, cursorMessage all green.

- [ ] **Step 2: API-mode regression baseline (frozen core unchanged)**

With `config.actuationMode` = `"api"` and the local llama-server running, run the smoke set:

Run: `npm run eval -- eval/smoke-questions.json` (from `backend/`)
Expected: completes with no crashes; results consistent with the pre-change baseline in `eval/results.csv` (action-correctness unchanged — this proves the gated edits did not disturb the API path). Record the run.

- [ ] **Step 3: Pixel-mode end-to-end demo**

Set `config.actuationMode` to `"pixel"`, ensure `CRAFTX_API_KEY` is in the root `.env`, start all three processes (llama-server is not needed for pixel mode, but backend + frontend are), open `http://localhost:5173`, pick **Zillow**, and ask: *"Switch to the ZRI dashboard tab and report the current Zillow Rent Index (ZRI) value shown for the United States."*

Verify:
- The Watch live view shows the synthetic **agent cursor** gliding to the ZRI tab and a click ripple.
- The run reaches an answer (expect **$1,477**; more steps than API mode's 2 is fine).
- `read_console_messages` shows no errors; `read_network_requests` shows the CraftX `/api/v1/chat/completions` calls.
- Open the run in **History** and confirm each click step renders a **click-point crosshair** on its frame (toggle overlays on).

- [ ] **Step 4: Reset config default and record results**

Set `config.actuationMode` back to `"api"` (the committed default). Note the pixel-mode run's step count and answer in the README/eval notes, mirroring the existing frozen-core regression-gate practice.

- [ ] **Step 5: Commit any recorded results**

```bash
git add README.md backend/eval/results.csv
git commit -m "$(cat <<'EOF'
Record pixel-mode + api-mode eval gate results

api-mode smoke baseline unchanged; pixel-mode Zillow ZRI run executes
end to end with visible cursor.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Mode flag + two profiles → Tasks 1, 9. Provider-agnostic OpenAI-compatible client + env-var-only key → Task 1. Raw-coordinate `click` action → Task 2. Browser-level click + transform → Task 3. Loop-guard exemption, no-diff feedback, cursor events, click-point persistence → Task 4. Pixel prompt (soft parity) → Task 5. Live synthetic cursor → Tasks 6, 7. Replay click marker → Tasks 4 (persist), 8 (render). Config + data-egress doc → Task 9. Frozen-core eval gate → Task 10. All spec sections map to a task.
- Non-goals honored: no grid/markers, no computer-use tool, no hover, no pure-screenshot mode, no `perception.js`/`inventory.js`/`eval`-set edits.

**Placeholder scan:** every code step shows complete code; commands have expected output. The only intentionally prose-level step is Task 9 Step 3 (README wording) and Task 7 Step 4 (locate two wiring points in `Watch.jsx`) — both name the exact file and the exact additions.

**Type consistency:** `resolveVlmTarget`/`authHeaders` (Task 1) used by `callVlm` (Task 1). `ClickAction` fields `nx,ny,target` (Task 2) match the actuator (Task 3), orchestrator (Task 4), prompt example (Task 5), and overlay `click_point` (Tasks 4, 8). `vizPointToPagePixels(box, nx, ny)` signature identical in Task 3 def and test. `agent_cursor` event shape `{idx,nx,ny,phase}` (Task 4) matches `server.js` forwarding and `broadcastCursor(nx,ny,phase)` (Task 6). WS `{type:"cursor",nx,ny,phase}` (Task 6) matches `api.js`/`useLiveChannel`/`LiveStage` (Task 7). `overlay.click_point={nx,ny,target}` (Task 4) matches `Stage.jsx` render (Task 8). `config.pixel={vlmEndpoint,modelName,vlmApiKeyEnv}` (Task 9) matches `resolveVlmTarget` (Task 1).

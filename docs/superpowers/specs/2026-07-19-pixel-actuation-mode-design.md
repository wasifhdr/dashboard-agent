# Pixel-Clicking Actuation Mode — Design Spec

**Date:** 2026-07-19
**Status:** Approved design, pending implementation plan
**Owner:** system/showcase (this repo)
**Related:** `../AGENT_PLAN.md` §10 deferred backlog ("pixel-actuation benchmark-parity mode"); `CLAUDE.md` frozen-core policy; `docs/LIVE_TAKEOVER_PLAN.md` (reused input machinery)

## 1. Purpose

Add a **config-selectable pixel-clicking actuation mode** in which a frontier VLM operates a Tableau dashboard by clicking real screen coordinates — with a visible cursor in the live view — instead of calling the Tableau Embedding API. The mode serves two goals at once:

- **Demo:** the agent's operation becomes *watchable* — a cursor glides to a control and clicks it, which today's API actuation cannot show (the API mutates state with no cursor).
- **Benchmark parity:** a pixel/screenshot-driven actuation channel comparable to the DashboardQA paper's screenshot-only setup, runnable side-by-side against the existing API-actuation agent via the eval harness.

This is a **soft-parity** design: in pixel mode the agent still receives the structured control inventory (so it knows *what* to operate) but actuates by *clicking* (it must find and hit the control on screen). This isolates the actuation channel while keeping runs reliable enough to demo — a fully screenshot-only variant (no inventory) is explicitly out of scope for v1.

## 2. Goals / Non-goals

**Goals**
- A `config.json`-selected actuation mode that coexists with today's API actuation as a separate profile, leaving API-mode behavior byte-for-byte unchanged.
- Provider-agnostic VLM client (OpenAI-compatible `/v1/chat/completions`) that works with a hosted, API-key-authenticated endpoint. Initial target: **CraftX** serving **Qwen3 VL 30B A3B Instruct**.
- Raw normalized-coordinate grounding (`nx, ny ∈ [0,1]`) emitted by the model, mapped to page pixels and dispatched via Playwright `page.mouse`.
- A visible synthetic cursor in the **live Watch** view; a static click-point marker in **replay/History**.
- Reuse of the existing perceive → prompt → validate → execute → settle → persist loop, its step budget, timeouts, and non-progress escalation.

**Non-goals (v1)**
- Pure screenshot-only mode (no inventory). Kept as a possible later variant.
- Hover-for-tooltip reads. Clicks only; value *reading* stays visual from the screenshot as today.
- Grid / numbered-marker grounding overlays. A frontier grounding-capable model makes raw coordinates the right choice; the grid was only a weak-4B-model crutch.
- Anthropic computer-use tool integration. Raw coords in the existing schema is the chosen depth; computer-use remains a possible future upgrade.
- Any change to `perception.js`, `inventory.js`, or the `eval/` question sets.

## 3. Background & key architectural facts

- **Playwright clicks at the browser level, not page JS**, so the cross-origin Tableau `<canvas>` iframe — which blocks DOM introspection — does *not* block mouse input. A click at `(x, y)` lands wherever it lands. This is why pixel actuation is feasible where AGENT_PLAN.md originally assumed it was not.
- The hard part already exists: `conversationRuntime.dispatchInput()` (live-takeover subsystem) already maps normalized coordinates to page pixels and dispatches `page.mouse.move/click/wheel`. Pixel actuation reuses this exact transform family, sourced from VLM output instead of a human client.
- **Headless Chromium renders no hardware cursor** into screenshots or the CDP screencast. A visible cursor must be *synthesized* — it is never captured.
- The VLM's image is `screenshotViz` (a `locator(VIZ_SELECTOR).screenshot()` of the viz element), resized to `imageLongSide` (≤1280). The model emits coordinates normalized to *that image*; the actuator maps them to page pixels via the viz element's bounding box. One coordinate space end to end.
- Qwen-VL family models are grounding-strong (bounding-box / pointing), so raw-coordinate output is well-supported.

## 4. Architecture

```
config.actuationMode = "pixel"
        │
        ▼
orchestrator loop (unchanged shape)
  perceive(screenshotViz) → inventory → prompt(pixel variant) → validate(zod, + click)
        → execute(click via page.mouse) → settle(pixel diff) → persist
                                   │                       │
                                   ▼                       ▼
                       Authorization: Bearer <key>   overlay.click_point (replay marker)
                       POST provider /v1/chat/completions   + onEvent agent_cursor → WS (live cursor)
```

**Two coexisting profiles**
- *Profile A* — `actuationMode:"api"` + local llama-server. Today's demo, untouched.
- *Profile B* — `actuationMode:"pixel"` + hosted VLM endpoint (CraftX/Qwen3-VL). The new cursor demo / parity track.

## 5. Components & changes

Files marked **[frozen]** are in the frozen agent core (`CLAUDE.md`); changes are gated so API-mode behavior is unchanged, and require the eval re-run in §8.

### 5.1 Provider boundary — `vlmClient.js` [frozen]
- Completions URL: `${config.vlmEndpoint ?? config.llamaEndpoint}/v1/chat/completions`. For CraftX, `vlmEndpoint = "https://api.craftx.corecraftsolutions.com/api"` composes to `…/api/v1/chat/completions`.
- Auth: if `config.vlmApiKeyEnv` is set, read `process.env[config.vlmApiKeyEnv]` and add `Authorization: Bearer <key>`. When unset (local mode), no auth header is sent — unchanged.
- Model: `config.modelName` (e.g. `"Qwen3 VL 30B A3B Instruct"`).
- Request body stays OpenAI-compatible (base64 `image_url`, `response_format: json_object` when `promptStyle === "constrained_json"`). The last-JSON-object fallback extractor and re-prompt policy are reused as-is.
- **Pixel prompt variant:** when `actuationMode:"pixel"`, use a pixel-mode system prompt (see §5.6). API-mode prompt path is untouched.

### 5.2 Action schema — `actionSchema.js` [frozen]
Add one variant to the discriminated union:
```js
const ClickAction = z.object({
  type: z.literal("click"),
  nx: z.number().min(0).max(1),   // normalized x over the viz image (0 = left, 1 = right)
  ny: z.number().min(0).max(1),   // normalized y over the viz image (0 = top,  1 = bottom)
  target: z.string().optional(),  // human-readable label, for overlay/logging only
});
```
Adding a variant does not alter existing variants, so API-mode validation is unchanged. `click` is only *emitted* in pixel mode (the API-mode prompt never mentions it) and is additionally rejected by the actuator/orchestrator when `actuationMode !== "pixel"`.

### 5.3 Actuator — `actuator.js` [frozen]
Add a `click` branch that operates at the browser level (not via `__agentBridge`):
```js
const box = await page.locator(VIZ_SELECTOR).boundingBox();      // viz element in page pixels
if (!box) return { ok: false, error: "Viz element not measurable (mid-transition); retry." };
const px = box.x + action.nx * box.width;
const py = box.y + action.ny * box.height;
await page.mouse.move(px, py, { steps: 12 });                    // glide (also cues the live cursor)
await page.mouse.click(px, py);
return { ok: true, point: { nx: action.nx, ny: action.ny, px, py } };
```
- `VIZ_SELECTOR` is `tableau-viz#agentViz` (duplicated as in `conversationRuntime`, since `perception.js` is frozen and does not export it).
- Runs under the existing `executeActionWithTimeout` (30s).
- `describeAction` gains a `click` case: `Click: <target ?? (nx,ny)>`.
- Only executes when `actuationMode:"pixel"`; otherwise returns an "unsupported action" error (matches the existing default branch shape).

### 5.4 Orchestrator — `orchestrator.js` [frozen]
- **Loop-guard exemption:** a click's effect depends on current UI state, not just coordinates (open-dropdown → click-value is a legitimate repeat-looking sequence). `click` is exempt from the exact-repeat rejection, but remains fully subject to the step budget (15), the consecutive-non-progress escalation, the wall-clock, and the max-2-consecutive-waits rule. `actionKey` for a click returns a coarse rounded key used only for telemetry, never for rejection.
- **No-diff corrective feedback:** if a click settles with no changed-region diff for 2 consecutive clicks (matching the existing non-progress escalation threshold), the escalation feedback tells the model *"your last click produced no visible change — re-read the screenshot and aim at the actual control."* This is the pixel-mode analogue of decoy recovery.
- **Cursor events:** emit `onEvent({ type: "agent_cursor", idx, nx, ny, phase })` with `phase:"move"` just before `page.mouse.move` and `phase:"click"` at the click.
- **Persist click point:** `persistAndEmit` writes `overlay.click_point = { nx, ny, target }` for click steps.
- Settle + perceive + changed-region diff after a click are unchanged.

### 5.5 Cursor visualization
**Live (Watch) — synthetic cursor over the screencast.**
- `server.js` forwards `agent_cursor` events onto the existing screencast WebSocket via `conversationRuntime.broadcast({ type: "cursor", nx, ny, phase })`.
- The Watch screencast component (frontend, mutable) renders a synthetic cursor layer positioned at `left: nx*100%, top: ny*100%` of the cropped viz it already displays (coords are viz-relative, so no vizbox math). CSS transition animates the glide on `"move"`; a ripple/pulse plays on `"click"`.
- The agent cursor is styled distinctly (e.g. a labeled "◆ agent" pointer) so it reads differently from the user's own cursor during takeover, reinforcing the existing `lock` state.

**Replay (History) — static click marker.**
- Add `click_point` to `overlay_json` alongside `action_badge` / `widget_bbox` / `changed_regions`.
- The shared overlay renderer draws a crosshair-with-ripple at `(nx, ny)` of the frame — a new mark type in the existing SVG overlay system, toggleable like the others. Static, no animation.

**Graceful degradation.** CLI runs and any run with no connected watcher drop the `agent_cursor` events (no `conversationRuntime`); persistence and the replay marker are unaffected because `click_point` comes from the actuator's returned coordinates, not the live channel.

### 5.6 Pixel-mode prompt (in `vlmClient.js`)
A second system prompt, used only in pixel mode. It:
- Still lists the control inventory (soft parity) so the model knows what exists.
- Instructs the model to act by clicking, emitting `{"type":"click","nx":…,"ny":…,"target":"…"}` with `nx,ny` as fractions of the image, `(0,0)` top-left.
- Explains the multi-step pattern: click a control to open it, read the updated screenshot, then click the value.
- Keeps `answer` / `fail` / `wait` semantics and the ≤2-sentence thought rule.
- Keeps `response_format: json_object`.

### 5.7 Config & key wiring
- New `config.json` fields: `actuationMode` (`"api"` default | `"pixel"`), `vlmEndpoint`, `modelName`, `vlmApiKeyEnv`. Profile B example:
  ```json
  {
    "actuationMode": "pixel",
    "vlmEndpoint": "https://api.craftx.corecraftsolutions.com/api",
    "modelName": "Qwen3 VL 30B A3B Instruct",
    "vlmApiKeyEnv": "CRAFTX_API_KEY"
  }
  ```
- **Env loading:** add `dotenv` and load the **root** `.env` explicitly at each entry point (`server.js`, `run.js`, `eval.js`) — `dotenv.config({ path: <repoRoot>/.env })` — because the backend runs from `backend/` while `.env` lives at the project root. Confirm `.env` is git-ignored. The key value is never read, printed, or committed by tooling; only the env-var *name* appears in `config.json`.

## 6. Data flow (one pixel step)

1. `screenshotViz` → PNG on disk (full-res) + resized base64 to the VLM.
2. `getInventory()` (unchanged) → normalized inventory for the prompt (reference only).
3. Pixel prompt + inventory + history + screenshot → provider `/v1/chat/completions` with `Authorization: Bearer`.
4. Validated `click{nx,ny,target}` → actuator maps to page pixels → `page.mouse.move`(glide) + `click`.
5. `agent_cursor` events broadcast to the live Watch cursor overlay.
6. `waitForSettle` (pixel diff) → screenshot → changed-region boxes.
7. Persist step with `overlay.click_point`; emit SSE step event.

## 7. Privacy / data egress

In pixel mode, per-step screenshots leave the machine and are sent to CraftX (a third-party API) — a change from the local-only architecture. The configured dashboards are Tableau **Public** (public data), so sensitivity is low. This will be documented in the README as a conscious trade-off of the mode. No credentials or personal data are sent; only dashboard screenshots and the prompt text.

## 8. Frozen-core impact & acceptance gate

Frozen files touched: `vlmClient.js`, `actionSchema.js`, `actuator.js`, `orchestrator.js`. All changes are gated on `actuationMode`, so API-mode paths are behaviorally unchanged.

**Acceptance gate (per `CLAUDE.md`):**
1. Run `eval/smoke-questions.json` + the batch eval in **API mode** → results must match the pre-change baseline (proves the frozen core is untouched in the default path).
2. Run once in **pixel mode** → clicks execute, at least the Zillow demo answers correctly, no crashes.
3. Record both in the eval results / README, mirroring the existing frozen-core regression-gate practice.

## 9. Verification / demo

Drive **Zillow → "Switch to the ZRI dashboard tab and report the current ZRI value for the United States" → $1,477** in pixel mode:
- Watch the synthetic cursor glide to the ZRI tab and click; confirm the reported value.
- Check `read_console_messages` and `read_network_requests` (now including the CraftX call) for errors.
- Expect more steps than API mode's 2, since clicking is inherently multi-step.

Second demo (self-correction): a click that lands off-target should trigger the no-diff corrective feedback and recover within a few steps.

## 10. Testing

- **Unit:** `nx,ny → (px,py)` transform against a known bounding box; `ClickAction` zod validation (bounds, missing fields); `describeAction` click formatting.
- **Integration:** a probe-style single pixel-click on a known control, asserting a non-empty changed-region after settle.
- **Regression:** the API-mode eval baseline from §8.1.

## 11. Open questions / risks

- **Grounding accuracy of Qwen3-VL-30B on dense dashboards** — mitigated by soft parity (inventory as context), the no-diff corrective loop, and the step budget; measured in the pixel-mode eval.
- **Coordinate drift if the viz auto-resizes mid-run** (host page shrink after `FirstInteractive`) — the actuator re-reads `boundingBox()` per click, so each click uses current geometry.
- **Provider latency/cost per step** — acceptable for demos; not optimized in v1.
- **`.env` path portability** — explicit root-relative path chosen over cwd-relative to avoid the backend/ vs root mismatch.

## 12. Rollout

1. Env/config plumbing + provider auth in `vlmClient.js` (no behavior change in API mode).
2. Schema + actuator click branch + orchestrator gating.
3. Cursor events + live overlay + replay marker.
4. Pixel prompt.
5. Eval gate (API-mode baseline + pixel-mode run) + README docs.

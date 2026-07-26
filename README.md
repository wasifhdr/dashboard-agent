# Tableau Dashboard QA Agent

Local VLM agent that answers questions about interactive Tableau Public dashboards by operating them (filters, parameters, tabs) through the Tableau Embedding API v3, with every step (reasoning, action, screenshot) recorded and viewable in a trajectory viewer.

See [docs/AGENT_PLAN.md](docs/AGENT_PLAN.md) for the original agent build plan, architecture, and contracts - all 4 phases are complete. See [docs/LIVE_TAKEOVER_PLAN.md](docs/LIVE_TAKEOVER_PLAN.md) for the live, multi-turn conversation & takeover system built on top of it (Phases B0-B4, also complete, with one regression check still pending - see the Status entry below). [Setup](#setup) gets it running; the phase-by-phase history below covers how it got here.

## Status

**Phase 0 complete.** All foundational primitives validated against real Tableau Public dashboards:

- `scripts/start-llama.ps1` + `scripts/vision-smoke-test.js` — confirmed the chosen model (Qwen3-VL-4B base + Claude-Opus reasoning LoRA) retained vision; it correctly transcribed dense axis labels, legends, and percentages from a real dashboard screenshot.
- `public/host.html` + `window.__agentBridge` — embeds a `<tableau-viz>` via Embedding API v3 and exposes inventory/filter/parameter/sheet control methods. Verified end-to-end on 3 real DashboardQA-sourced Tableau Public dashboards (`backend/probe.js <url>`): inventory enumeration (including full categorical-domain enumeration via `getDomainAsync` — this is available, so the `domain: null` fallback path is a true fallback, not the common case), filter application, dashboard-level filter broadcast across worksheets, settle-gate timing, and pixel-diff change regions all work correctly.
- `src/perception.js` — Playwright session open (with a bounded readiness timeout, not an unbounded promise await), settle gate, screenshot, coarse changed-region diffing.
- `src/inventory.js` — stable-ID (`S*`/`F*`/`P*`) normalization, merges same-field filters across worksheets per the spec.

Implementation notes that update AGENT_PLAN.md's assumptions:
- Tableau's own internal iframe reuses `id="viz"`, so the `<tableau-viz>` element uses `id="agentViz"` to avoid Playwright locator collisions.
- Filter domain enumeration (`getDomainAsync`) works reliably on the dashboards tested — the plan's uncertainty here is resolved in the optimistic direction.
- `Dashboard.applyFilterAsync` (not per-worksheet iteration) is used for categorical filters when the active sheet is a dashboard — Tableau natively broadcasts it to every worksheet sharing the field. Range filters have no dashboard-level equivalent and are still applied per-worksheet.
- The host page auto-shrinks the `<tableau-viz>` element to the dashboard's real published size after `FirstInteractive`, instead of leaving dead black margin at the default 1600x1000 box — matters for image-token budget on a 6GB-VRAM model.

**Phase 1 complete.** Full perceive -> inventory -> prompt -> validate -> execute -> settle -> persist agent loop, driven end-to-end by the VLM:

- `src/actionSchema.js` — zod discriminated-union schema for the 7 action types.
- `src/vlmClient.js` — prompt builder (inventory + history formatting, domain truncation), image resize, `response_format: json_object` call to llama-server with a last-JSON-object fallback extractor (tolerates leaked `<think>` preambles), up to 2 re-prompts on invalid/malformed output.
- `src/actuator.js` — executes a validated action against the bridge, with case-insensitive domain matching and near-match suggestions on failure, wrapped in a 30s timeout.
- `src/store.js` — better-sqlite3 sessions/steps schema, WAL mode, frames never deleted.
- `src/orchestrator.js` — the loop itself: step budget (15), loop guard (exact-repeat rejection + max-2-consecutive-waits), forced best-effort answer on budget exhaustion, per-action timeout, session wall clock, changed-region overlay computed every step, best-effort widget-bbox lookup.
- `run.js` — CLI runner (`node run.js <tableau-url> "<question>"`), streams steps to stdout.
- `eval/smoke-questions.json` — 6 handwritten QA pairs across the 3 Phase-0 dashboards (1 no-action-needed, 3 filter-required, 1 tab-required, 1 unanswerable-trap).

All 6 smoke questions were run and inspected against real dashboard frames (not just trusted blindly). Results: 5/6 have a manually-verified-correct final answer; the 6th (`q4`, counting disease-case icons on a dense multi-row icon chart) executed the correct filter action, but the icon-to-label alignment on that specific chart turned out to be too fine-grained to confidently verify even by manual pixel inspection — so its answer is recorded as unverified rather than confirmed right or wrong (see `eval/questions.json`'s `q4` notes). Per the plan, action correctness (not answer correctness) is Phase 1's bar, and every action taken across all 6 runs was correct.

Notable finding during testing: on `q2` (Zillow "Boston, MA" ZHVI), the model initially fixated on a decoy - this workbook has an orphaned parameter also named "Select Region" (`P1`/`P4`) that is *not* wired to anything visible, alongside the real, working `RegionName` filter. The actuator correctly executed the no-op parameter change (Tableau itself accepts it - not a validation bug), and the loop guard correctly blocked repeated retries of the same dead-end action, but the model needed several rejections to try a different control. Fixed by escalating the corrective-feedback message after 2 consecutive non-progress steps to explicitly say "re-scan the FULL inventory, both filters and parameters - this is likely the wrong control" - cut convergence from 10 steps to 5, with the model's own next-step reasoning explicitly citing the hint ("parameter shows X but the dropdown shows Y, suggesting a wiring issue").

**Phase 2 complete.** The showcase UI - a live-streaming trajectory viewer plus session replay.

Backend additions:
- `src/sessionBus.js` - in-memory per-session event buffer + subscriber fan-out, so an SSE client connecting mid-run gets everything so far replayed, then live events as they happen.
- `src/server.js` - now launches one shared Playwright browser at startup (reused across sessions instead of one per run), enforces the one-session-at-a-time mutex, and exposes: `POST /api/sessions` (starts a run, returns the id immediately), `GET /api/sessions` (history list), `GET /api/sessions/:id` (full persisted trajectory, for replay), `GET /api/sessions/:id/events` (SSE, live only), `GET /api/config` (dashboard picker options), static `/frames/...`.
- `adaptAndPublish()` in server.js translates the orchestrator's internal `step` event into the separate `action` / `frame` / `inventory` SSE events from the plan's 6.7 contract, keeping that translation out of the already-tested orchestrator loop.
- `src/orchestrator.js` gained two small additive changes: an optional pre-generated `sessionId` (so the server can respond with the id synchronously before the run finishes) and a lightweight inventory summary attached to each step event.

Frontend (`frontend/`, Vite + React, dark theme, no UI framework): `Launcher` (dashboard picker + free URL + question), `TrajectoryViewer` (3-pane: `StepTimeline` left, `Stage` center with SVG changed-region/widget-bbox overlays + prev/next/play, `DetailsPanel` right with thought/action JSON/inventory summary/warnings), `Header` (question, status chip, budget meter, final-answer card), `SessionsList` (history/replay picker). Live and replay modes are driven by the same components from a shared per-step state shape - live mode reduces the SSE event stream into it, replay mode fetches the full trajectory once and populates it directly, so a past session renders pixel-identical to how it looked live.

Verified end-to-end in a real browser (Chrome via the preview tool, not just curl): started a live session from the launcher, watched it stream through both steps with the correct thumbnails/badges/thought/action/inventory/final-answer, confirmed the changed-region overlay boxes matched the actual pixel diff between frames, navigated with Prev/Next and direct step clicks, toggled overlays on/off, then opened a Phase-1-era CLI-run session from History and confirmed it replays with byte-identical thought/action/answer/inventory-counts to what the CLI printed at the time - zero console errors, zero failed network requests throughout.

**Phase 3 complete.** Hardening and evaluation readiness.

- **Error taxonomy.** Fixed a real gap: a VLM network/timeout failure inside `getNextAction`'s retry loop was previously unhandled and could crash a session mid-run; it's now caught, classified as `vlm_error` (distinct from `invalid_json`), and retried the same as any other transient failure. Added a `sessions.error_message` column (safe `ALTER TABLE` migration for the pre-existing DB) so *why* a session failed (viz load timeout, 3x VLM failure, an unexpected crash) is recorded and threaded all the way through the orchestrator → store → SSE `session_done` event → REST replay → CLI → the frontend `Header`, instead of a bare "ERROR" chip with no explanation. Added an `empty_inventory` warning (dashboard has no operable controls at all - agent falls back to read-only). The server's catch-all safety net for an unexpected crash now also writes `finishSession` so a bug can no longer leave a session stuck at `status='running'` forever in the History list.
- **Curated dashboards.** Added 2 more real Tableau Public dashboards (via `probe.js`, load time + non-empty inventory verified) alongside the original 3, for **5 total**: see `config.json`. One additional candidate (an AirBnB Berlin dashboard) was tested and *rejected* - its stats panel showed a stuck loading spinner in the captured screenshot, a reliability risk not worth including in a curated "known-good" list.
- **Batch eval harness** (`eval.js`, `eval/questions.json`): runs a list of questions sequentially against one shared browser, writes `eval/results.csv` (id, question, dashboard, answer, status, steps, duration, session id, error). Each question runs in its own try/catch so one crashing question can't take down the batch. 10 questions span all 5 dashboards and exercise every action type, including `set_range_filter`, which no earlier question had covered.
- **Model A/B** (`scripts/start-llama-stock.ps1`, `eval/reading/`, `eval/reading-bench.js`): a 10-crop chart-reading micro-benchmark built from real, already-visually-verified session frames, comparing the Jackrong Claude-Opus-reasoning distill against the stock `Qwen3.5-4B` base it was fine-tuned from (same base family; the stock build available locally is Q6_K rather than Q4_K_M, a minor quantization mismatch worth noting). See [Model A/B results](#model-ab-results) below.

**Phases B0-B4 complete.** The live, multi-turn conversation & takeover system - see [docs/LIVE_TAKEOVER_PLAN.md](docs/LIVE_TAKEOVER_PLAN.md) for the full build plan, data model, and transport contracts. This turns "one question = one fresh Playwright page, reset to the dashboard's default state" into "one **conversation** = one persistent browser context the user can watch live and briefly drive between turns":

- **`src/conversationRuntime.js`** (new) - the single owner of a conversation's long-lived Playwright context+page. `createRuntime()` opens the dashboard once (not per question) and keeps it alive across every turn; it exposes `addClient`/`removeClient`/`broadcast` for the live WebSocket, `setMode("idle"|"agent")` as the turn-based input lock, `dispatchInput()` for forwarded mouse/keyboard, and `captureTakeoverStart()`/`captureTakeoverEnd()` for before/after takeover bookkeeping. `close(reason)` tears everything down on an explicit close, an idle timeout, or an unrecoverable page crash.
- **`store.js`** gained a `conversations` table, `sessions.conversation_id`/`turn_index` columns (a "session" row is now one turn inside a conversation - legacy rows with `conversation_id IS NULL` still replay standalone exactly as before), and a `takeovers` table (before/after frame paths, inventory JSON, a slice of the bridge's event log, and a computed diff) - all additive migrations, the same guarded-`ALTER TABLE` idiom as Phase 3's `error_message` column.
- **`orchestrator.js`**'s `runSession` gained reuse-page options (`page`, `ownsPage:false`, `conversationId`, `turnIndex`) that all default to today's behavior, so `run.js` and the batch harness are untouched - a turn is the identical perceive→inventory→prompt→validate→execute→settle→persist loop, it just runs on a page the conversation runtime already opened instead of opening (and closing) its own.
- **Live view.** The runtime starts a CDP `Page.startScreencast` session and streams frames plus viz-geometry (`vizbox`) updates over a new per-conversation `WS /api/conversations/:id/live` (Origin-checked in `server.js`'s `attachLiveWebSocket()` against the same allowlist the Express CORS config uses). `frontend/src/screens/Watch/useLiveChannel.js` consumes it and exposes `{liveFrameUrl, vizBox, mode, connected, closedReason}`; `LiveStage.jsx` renders the live frame with a lock veil while `mode==="agent"`.
- **Takeover.** Between turns, `mode` flips so forwarded mouse/keyboard actually reaches the page - the user can click a filter, drag a range slider, or switch tabs directly on the live dashboard, and the *next* turn resumes from whatever state that leaves (the agent's own reasoning history/loop-guard/inventory IDs still reset per turn; only the dashboard's physical state carries over). A `lock`/`unlock` broadcast ensures only one actor drives at a time. Each takeover's before/after frame + inventory diff is persisted and rendered as a card in the thread.
- **`server.js`** replaced the old one-session boolean with conversation-aware state (`turnRunning`, `conversationOpening`, `stopRequests`) and added `POST /api/conversations`, `POST /api/conversations/:id/turns`, `POST /api/conversations/:id/close`, `GET /api/conversations`, `GET /api/conversations/:id` (full multi-turn + takeover replay). `POST /api/sessions` is kept as a backward-compatible shim; the CLI still calls `runSession` directly and never touches HTTP.
- **Replay + History.** `GET /api/conversations/:id` returns every turn's full trajectory plus takeovers in order, replayed with no live processes running. `store.listConversationsWithSummary()` backs a unified History list (turn count, dashboard, last question/answer/status) alongside legacy standalone sessions.
- **Lifecycle hardening (B4).** An idle timer (`conversationIdleMs` in `config.json`, 30 minutes) auto-closes an unattended conversation; a `page.once("crash", ...)` listener closes the runtime on an unrecoverable browser crash instead of leaving it hung forever; a screencast-start failure now broadcasts `{type:"closed", reason:"screencast_failed"}` instead of silently leaving the live view blank (per-turn frames still work either way). A new "End session" control in `StatusBar.jsx` closes the conversation explicitly from the UI (shows an inline error and stays put if a turn is running), and `useLiveChannel.js`/`LiveStage.jsx` now surface *why* a live connection ended - idle timeout, browser crash, screencast failure, or an explicit close - instead of a generic "disconnected" state.

**Not yet done:** the frozen-core regression re-run called for in `LIVE_TAKEOVER_PLAN.md` §9 Phase B4 item 5 - re-running the smoke set and `npm run eval -- eval/questions.json` against a baseline captured before B0, to confirm the reuse-page changes to `orchestrator.js` didn't shift any answers. The [Model A/B results](#model-ab-results) and [Batch eval harness results](#batch-eval-harness-results) below predate this refactor; `orchestrator.js`'s reuse-page changes are additive and default-preserving and the CLI path still runs fine by hand, but the full comparison hasn't been re-run against a pre-B0 baseline yet - that's a pending, separate step, not a completed one.

See [Setup](#setup), [Demo script](#demo-script), and [Troubleshooting](#troubleshooting) below.

## Architecture

```
                    ┌────────── React "Docent" Viewer (Vite, :5173) ───────────────────┐
                    │  Landing · Watch (LiveStage + Stage + StatusBar) · History        │
                    └───────▲───────────────────────▲────────────────────▲─────────────┘
                            │ REST (conversations /  │ SSE (per-turn      │ WS (live
                            │ turns / replay)        │ step events)       │ screencast + input)
                    ┌───────┴───────────────────────┴────────────────────┴─────────────┐
                    │            Node backend (Express, ESM, :8788)                     │
                    │  conversationRuntime.js: ONE persistent Playwright context+page    │
                    │  per conversation - opened once, kept alive across every turn,     │
                    │  torn down on explicit close / idle timeout / page crash           │
                    │    ├─ CDP screencast + vizbox geometry → broadcast over live WS     │
                    │    ├─ dispatchInput(): forwarded mouse/keyboard, turn-based lock     │
                    │    └─ captureTakeoverStart/End(): before/after frame+inventory diff  │
                    │  Orchestrator: a "turn" runs the same agent loop (step budget,       │
                    │  loop guard, settle gate) on the runtime's already-open page          │
                    │  instead of opening/closing its own                                  │
                    │    ├─ Perception:  Playwright → screenshot of embedded viz            │
                    │    ├─ Grounding:   control inventory via Embedding API bridge          │
                    │    ├─ Actuation:   bridge calls (filters/params/sheets)                │
                    │    ├─ VLM client:  llama-server (OpenAI-compatible, :8080)              │
                    │    └─ Store:       better-sqlite3 (conversations/sessions/takeovers/     │
                    │                    steps) + PNG frames, never deleted                   │
                    │  sessionBus.js fans per-turn step events out over SSE                    │
                    └───────┬───────────────────────────────────────────────────────────────┘
                            │ Playwright drives ONE shared long-lived browser
                            │ (one persistent context+page per active conversation)
                    ┌───────┴────────────────────────────────┐   ┌───────────────────┐
                    │ host.html (served by backend, loaded    │   │ llama-server        │
                    │ in the Playwright browser, NOT the       │   │ (:8080)              │
                    │ user's): <tableau-viz> + window.         │   │ Qwen3.5-4B distill    │
                    │ __agentBridge (Embedding API v3)         │   │ or stock, swappable  │
                    └──────────────────────────────────────────┘   └───────────────────┘
```

The user's browser never embeds the Tableau viz directly - Tableau renders marks to canvas inside a cross-origin iframe, which the user's own page JS can't screenshot or introspect. Playwright, operating at the browser-automation level, can.

A **conversation** now owns one persistent Playwright context+page for its whole lifetime (`conversationRuntime.js`); a **question** is a **turn** within that conversation, running the identical perceive→act→settle agent loop but resuming into whatever state the previous turn - or a user takeover in between - left the dashboard in, instead of reloading it from scratch. The React viewer consumes two independent streams from the backend: the persisted per-step trajectory (frames/events over REST+SSE, exactly as before Phase B0) and, while a conversation is live, a real-time CDP screencast plus a forwarded-input channel over WebSocket, for watching and briefly driving the actual browser between turns.

## Layout

```
backend/    Node ESM backend (Express, Playwright, better-sqlite3, VLM client, orchestrator)
  src/            core modules (perception, inventory, vlmClient, actuator, orchestrator, store, server, sessionBus,
                   conversationRuntime - persistent per-conversation Playwright context/page + live screencast/input, B0-B4)
  public/         host.html (the Tableau embed page Playwright loads)
  scripts/        llama-server launchers + vision smoke test
  eval/           questions.json, smoke-questions.json, reading/ (micro-benchmark), results.csv
  run.js          CLI: node run.js <tableau-url> "<question>"
  probe.js        Phase-0-style manual dashboard validator
  eval.js         batch harness: node eval.js [questions.json]
frontend/   Vite + React "Docent" UI - Landing (marketing/picker), Watch (live view + step replay), History (unified list)
docs/       AGENT_PLAN.md + LIVE_TAKEOVER_PLAN.md (build plans) and DESIGN.md (design system)
```

## Setup

**Prerequisites:** Node 18+, a local llama.cpp build with CUDA support (`E:\llama.cpp\` in this project), and the model files below.

**Model files** (local paths, not committed):
- Primary (Jackrong Claude-Opus-reasoning distill): `E:\llama.cpp\models\Jackrong_Qwen3.5-4B.Q4_K_M_v2.gguf` + `Jackrong_Qwen3.5-4B.Q6_K_v2_mmproj.gguf`
- Stock comparison (Qwen3.5-4B base, no reasoning LoRA): `E:\llama.cpp\models\Qwen3.5-4B-Q6_K.gguf` + `qwen3.5-mmproj-F16.gguf`

**1. Start the model:**
```powershell
backend/scripts/start-llama.ps1          # primary model (default in config.json)
# or
backend/scripts/start-llama-stock.ps1    # stock comparison model - stop the other one first, only one fits in 6GB at a time
```
Wait for `main: server is listening on http://127.0.0.1:8080` and a `{"status":"ok"}` from `curl http://127.0.0.1:8080/health`. First load takes ~15-25s.

**2. Start the backend:**
```bash
cd backend
npm install       # first time only
npm run dev       # launches a shared Playwright browser + Express on :8788
```

**3. Start the frontend:**
```bash
cd frontend
npm install       # first time only
npm run dev       # Vite on :5173, proxies /api and /frames to :8788
```
Open `http://localhost:5173`.

**Other entry points** (all run from `backend/`, with llama-server + nothing else required):
- `npm run probe -- <tableau-url>` - one-off dashboard validator (inventory, screenshot, filter+settle+diff cycle), no VLM involved.
- `npm run run-agent -- <tableau-url> "<question>"` - CLI agent run, streams steps to stdout.
- `npm run eval -- eval/questions.json` - batch harness, writes `eval/results.csv`.
- `npm run reading-bench -- --label <name>` - chart-reading micro-benchmark against whichever model is currently loaded.
- `npm run vision-smoke-test -- <image.png>` - quick "can this model see at all" check.

## Demo script

**With live conversations (B0-B4) in place, lead with the two-turn Video Game Sales conversation that includes a manual takeover in between** - it's the demo that actually shows off what this phase built, rather than just the per-step agent loop the earlier demos below already covered: the dashboard stays open across turns, the audience watches the agent work in the **live** view (not just per-step frames), then the presenter takes the wheel for a few seconds before handing it back.

```
Dashboard:  Video Game Sales
Turn 1:     In the Top 5 Publishers chart, which publisher has the highest total sales?
Turn 1 →    Nintendo (agent answers live; the lock veil then lifts)
Takeover:   click the 'Electronic Arts' bar yourself, directly in the live view, to filter the dashboard to EA
Turn 2:     Which single game now has the highest global sales in the Top 10 Games chart?
Turn 2 →    FIFA 15 (agent reads the state you left it in - it never reloads or re-applies the filter itself)
```

Narrate it as: ask the first question and watch Docent answer live, the same as before; once it finishes, the lock veil disappears and the "Yours" badge appears - click the Electronic Arts bar yourself instead of asking the agent to; then ask the follow-up and watch it answer from the state *you* left it in. That last beat - a turn resuming into a human's manual edit, on the same live page, with no reload - is the concrete payoff of the whole persistent-conversation system and the one moment worth building the demo around. (Both turn values are verified: Nintendo tops the unfiltered publishers chart, and FIFA 15 is EA's top game after the filter.)

For a **quick single-turn fallback** (if the live WebSocket isn't cooperating, or time is short): a pure-reading question on the Video Game Sales dashboard is the fastest reliable demo (1 step, ~10s), exercising pixel-mode perception with no click needed.

```
Dashboard: Video Game Sales
Question:  In the Top 5 Publishers chart, which publisher has the highest total sales?
Expected:  Nintendo   (1 step, verified in pixel mode)
```

For a **richer single-turn demo** that shows pixel-click actuation end to end (a good "look, it operates the dashboard" moment): the Electronic Arts filter question on Video Game Sales. The agent pixel-clicks the big EA bar in the Top 5 Publishers chart, the whole dashboard re-filters to EA, and it reads the top game off the updated frame.

```
Dashboard: Video Game Sales
Question:  Click the 'Electronic Arts' bar in the Top 5 Publishers chart to filter to that publisher, then report which single game has the highest global sales in the Top 10 Games chart.
Expected:  FIFA 15   (2 steps, verified in pixel mode)
```

Pick large, clearly-labeled marks as click targets. Clicking the *small stacked rows* in the "Top Genres" chart instead makes the agent loop (10+ `rejected_loop` steps observed) because the pixel target is too small/ambiguous - a good cautionary note if asked about pixel-mode limits, but not something to demo live.

## Pixel-clicking actuation mode

By default, the agent operates dashboards through the Tableau Embedding API v3 (`__agentBridge` — `applyFilterAsync`, parameters, `activateSheetAsync`). A second, config-selected actuation mode is also available: **pixel mode**, where a hosted VLM (CraftX, serving Qwen3-VL-30B-A3B-Instruct) operates the dashboard by clicking on screen coordinates with a visible cursor, instead of calling structured bridge methods. This is useful for demoing/comparing a pixel-grounded actuation path against the API-grounded default.

**How to enable:**
- Set `"actuationMode": "pixel"` in `backend/config.json` (default is `"api"` — leave it alone unless you want pixel mode). The `config.pixel` block (`vlmEndpoint`, `modelName`, `vlmApiKeyEnv`) already points at the CraftX endpoint and doesn't need editing.
- Put `CRAFTX_API_KEY=<key>` in the root `.env` (git-ignored) — `resolveVlmTarget` in `vlmClient.js` reads the key from that environment variable at the name given by `vlmApiKeyEnv`, never from `config.json` itself.

**Data-egress note:** In pixel mode, per-step dashboard screenshots are sent to the configured third-party VLM endpoint (CraftX), unlike the default local-only pipeline. The configured dashboards are Tableau Public (public data), so sensitivity is low; no credentials or personal data are sent.

**Running the demo:** enable pixel mode as above, start the three processes (llama-server is not needed for a pixel-mode-only run, but leave the usual startup order otherwise unchanged), then ask the verified pixel-click question — Video Game Sales → "Click the 'Electronic Arts' bar in the Top 5 Publishers chart to filter to that publisher, then report which single game has the highest global sales in the Top 10 Games chart" (expect **FIFA 15**, 2 steps) — and watch the Watch screen: instead of semantic action cards, you'll see a visible cursor click the EA bar and the dashboard re-filter before it answers.

## Troubleshooting

- **llama-server won't start / OOM on load:** confirm no other llama-server is already holding the GPU (`tasklist` / check `nvidia-smi`). Only one model fits in 6GB at a time. If a model genuinely won't fit, drop `--ctx-size` to 6144 before trying a smaller quant.
- **Session hangs at "Running" forever:** shouldn't happen post-Phase-3 - every stage has a bounded timeout (viz load 90s, VLM call 120s, bridge action 30s, session wall clock 15min). If it does, check `backend` stdout for an unhandled exception; the server's crash safety net should still mark the session `error` in the DB, but a truly stuck Playwright page is the one thing that can't self-recover - restart the backend.
- **Settle timeout warnings:** shown when a dashboard update takes >12s to visually stabilize (slow Tableau Public rendering, not a bug). The step still completes with a `settle_timeout` flag; occasional ones are normal on heavier dashboards, frequent ones suggest that specific dashboard isn't a good fit for the curated list.
- **Empty inventory warning:** the dashboard has no API-operable filters/parameters/extra sheets - the agent can only answer from what's visible in the initial screenshot. Not an error, just a capability limit of that specific dashboard.
- **A dashboard has a "decoy" control:** some real-world workbooks have parameters or filters left over from authoring that aren't wired to anything visible. The loop guard + escalating corrective feedback (AGENT_PLAN.md-driven design) handles this automatically, typically converging within 2-3 extra steps - if you see a session burn most of its 15-step budget on this, that's worth investigating as a regression.
- **Image reading seems worse than expected:** check `config.imageLongSide` (1280px) hasn't been lowered, and that the dashboard's actual content isn't being letterboxed with dead margin (the host page auto-sizes to the dashboard's real published size after `FirstInteractive`, but a dashboard with `size.behavior === "automatic"` has no fixed size to snap to and may render at the default 1600x1000 box with wasted space - see the CA Revenue Sources dashboard for an example, its real content only occupies the left ~40% of a wider default canvas).

## Model A/B results

10-crop chart-reading micro-benchmark (`eval/reading-bench.js`), same prompts/images/token budget (600 max_tokens, temperature 0) for both models:

| Model | Score |
|---|---|
| Jackrong Qwen3.5-4B Claude-Opus-reasoning distill (Q4_K_M) | **10/10** |
| Stock Qwen3.5-4B base (Q6_K, no reasoning LoRA) | **8/10** |

The distill's 2 extra correct reads were both about *completing an answer at all*, not raw pixel-level perception: the stock model gave an empty response on the hardest crop (a dense waterfall chart with 12 small percentage labels) and misread which bar was labeled 28.3% on its first attempt, both consistent with a base model that hasn't been tuned to reliably close out a complete, well-formed answer under real task pressure. This is a genuinely useful signal for the research track: reasoning distillation - even from **text-only** Claude Opus traces, with no vision-specific data - correlated with *more* reliable chart reading here, not less, contrary to the original concern that text-only fine-tuning might degrade visual grounding.

Full per-crop results: `eval/reading/results-jackrong_distill.json`, `eval/reading/results-qwen3_5_4b_stock.json`.

**Methodology note:** the first pass used a 200-token budget and showed the stock model failing on roughly half the crops with *empty* responses. Raising the budget to 600 tokens changed the stock model's score substantially, consistent with it spending more of its output budget inside `<think>...</think>` before an answer than the reasoning-distilled model does. Both scores above are from the 600-token, fair-comparison run - do not compare against the discarded 200-token numbers.

## Batch eval harness results

`node eval.js eval/questions.json` against the primary model, 10 questions across all 5 curated dashboards, every action type exercised at least once (`set_filter`, `set_range_filter`, `set_parameter`, `switch_sheet`, `answer`, `fail`):

**10/10 questions completed, 0 harness-level crashes.** 9 reached `answered`, 1 (`q6`, the unanswerable trap) correctly reached `failed` in a single step with no looping. Of the 4 questions with independently-verified ground truth (`q1`, `q3`, `q5`, `q7`), all 4 matched exactly. `q2` (the decoy-parameter Boston question) again self-corrected and answered correctly, this run taking 7 steps rather than the earlier 5 - normal run-to-run variance, still comfortably inside the 15-step budget. `q10` was the first live-agent exercise of `set_range_filter` end to end and completed cleanly in 2 steps. Full detail in `eval/results.csv`.

## Deferred

Intentionally out of scope for the frontend revamp (see `../FRONTEND_PLAN.md`) - not built, not started:

- **Token streaming.** Thoughts are revealed via a client-side typewriter, not real token-by-token streaming from the VLM - the prompt caps thoughts at ≤2 sentences and the call uses `response_format: json_object`, so there's no meaningful token stream to forward, and streaming would also break the JSON-repair retry logic.
- **Voice (STT/TTS).** Deferred per the original project plan pending the core step-by-step answering being solid first. The Watch screen's feed is built from discrete, narratable step strings (thought, action label, outcome) specifically so TTS can be layered on without restructuring the data model later.
- **Open-web dashboard search with probe-gating.** The landing page's search is client-side keyword scoring over the 5 curated, `probe.js`-validated dashboards only (D8) - arbitrary Tableau Public URLs are supported via direct paste, but there's no "search the whole internet and validate what comes back" flow.
- **Literal click crosshairs on self-generated dashboards.** The agent acts through the Tableau Embedding API, not pixel clicks, so there's no cursor position to show (D10) - a semantic action card + best-effort widget highlight is the permanent design for Tableau targets. Literal crosshairs would only become meaningful for a future self-generated-dashboard target where pixel coordinates are actually known.

## Known findings worth reading before extending this system

- **Tableau's internal iframe reuses `id="viz"`** - the embedded element uses `id="agentViz"` to avoid Playwright locator collisions.
- **Filter domain enumeration (`getDomainAsync`) works reliably** on every dashboard tested - the `domain: null` fallback path is a true edge case, not the common case.
- **`Dashboard.applyFilterAsync` broadcasts natively** to every worksheet sharing a field when the active sheet is a dashboard - no manual per-worksheet iteration needed for categorical filters. Range filters have no dashboard-level equivalent and still need per-worksheet `applyRangeFilterAsync`.
- **Real-world dashboards can have decoy/orphaned controls** - a parameter or filter that sounds relevant by name but isn't wired to anything visible (a real workbook may ship a "Select Region" parameter that does nothing while a separate `RegionName` filter is the one that actually works). The system recovers via loop-guard rejection + escalating corrective feedback, not by detecting decoys directly (that's not generally knowable).
- **Dense, fine-grained charts (many small icons/marks close together) are genuinely hard to verify** even by manual human inspection of a screenshot, not just for the VLM - see the `q4` disease-icon-counting case. Don't treat a model's answer on this class of question as ground truth without independent verification.
- **A dashboard's screenshot can have significant dead margin** if `sheet.size.behavior === "automatic"` (no fixed published size to auto-snap the host page to) - see CA Revenue Sources, whose real content occupies only the left ~40% of its captured frame.

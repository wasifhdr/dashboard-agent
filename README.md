# Tableau Dashboard QA Agent

Local VLM agent that answers questions about interactive Tableau Public dashboards by operating them (filters, parameters, tabs) through the Tableau Embedding API v3, with every step (reasoning, action, screenshot) recorded and viewable in a trajectory viewer.

See [AGENT_PLAN.md](../AGENT_PLAN.md) (one level up) for the full build plan, architecture, and contracts. All 4 planned phases are complete - see [Setup](#setup) to run it, or the phase-by-phase history below for how it got here.

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

See [Setup](#setup), [Demo script](#demo-script), and [Troubleshooting](#troubleshooting) below.

## Architecture

```
                    ┌───────────── React Trajectory Viewer (Vite, :5173) ─────────────┐
                    │  Launcher · StepTimeline · Stage (SVG overlays) · DetailsPanel   │
                    └───────────▲──────────────────────────────▲──────────────────────┘
                                │ REST (start/list/replay)      │ SSE (live steps)
                    ┌───────────┴──────────────────────────────┴──────────────────────┐
                    │            Node backend (Express, ESM, :8788)                    │
                    │  Orchestrator: agent loop, step budget, loop guard, settle gate   │
                    │    ├─ Perception:  Playwright → screenshot of embedded viz        │
                    │    ├─ Grounding:   control inventory via Embedding API bridge     │
                    │    ├─ Actuation:   bridge calls (filters/params/sheets)           │
                    │    ├─ VLM client:  llama-server (OpenAI-compatible, :8080)        │
                    │    └─ Store:       better-sqlite3 (sessions/steps) + PNG frames   │
                    │  sessionBus.js fans live events out over SSE                      │
                    └───────────┬─────────────────────────────────────────────────────┘
                                │ Playwright drives one shared long-lived browser
                    ┌───────────┴────────────────────────────┐   ┌───────────────────┐
                    │ host.html (served by backend, loaded    │   │ llama-server        │
                    │ in the Playwright browser, NOT the       │   │ (:8080)              │
                    │ user's): <tableau-viz> + window.         │   │ Qwen3.5-4B distill    │
                    │ __agentBridge (Embedding API v3)         │   │ or stock, swappable  │
                    └──────────────────────────────────────────┘   └───────────────────┘
```

The user's browser never embeds the Tableau viz directly - Tableau renders marks to canvas inside a cross-origin iframe, which the user's own page JS can't screenshot or introspect. Playwright, operating at the browser-automation level, can. The React viewer only ever displays frames/events streamed from the backend.

## Layout

```
backend/    Node ESM backend (Express, Playwright, better-sqlite3, VLM client, orchestrator)
  src/            core modules (perception, inventory, vlmClient, actuator, orchestrator, store, server, sessionBus)
  public/         host.html (the Tableau embed page Playwright loads)
  scripts/        llama-server launchers + vision smoke test
  eval/           questions.json, smoke-questions.json, reading/ (micro-benchmark), results.csv
  run.js          CLI: node run.js <tableau-url> "<question>"
  probe.js        Phase-0-style manual dashboard validator
  eval.js         batch harness: node eval.js [questions.json]
frontend/   Vite + React trajectory viewer (dark theme, no UI framework)
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

For a live audience, **the Zillow Rent Index tab-switch question is the strongest single demo**: it's fast (2 steps, ~15-20s total), it visibly exercises a *real* multi-tab workbook switch (not just a filter), and the final answer is easy for an audience to verify against the screenshot themselves.

```
Dashboard: Zillow Home Value Index (April 2019)
Question:  Switch to the ZRI dashboard tab and report the current Zillow Rent Index (ZRI) value shown for the United States.
Expected:  $1,477
```

For a **second, richer demo** that shows the system recovering from a mistake (a good "look how it handles a hard case" moment): the Boston ZHVI question. This dashboard has a decoy parameter that isn't wired to anything, so the agent tries it, gets rejected by the loop guard, and self-corrects to the real filter within a few steps - a genuinely interesting trajectory to narrate live.

```
Dashboard: Zillow Home Value Index (April 2019)
Question:  What is the ZHVI (median home value) for Boston, MA according to the dashboard?
Expected:  $465,000 (typically 4-5 steps, including one rejected decoy attempt)
```

Avoid leading with `q4` (the CA Infectious Diseases icon-counting question) live - its answer is a genuinely hard, currently-unverified read, which is a fine research talking point but a confusing demo moment if the audience expects a confident right/wrong.

## Troubleshooting

- **llama-server won't start / OOM on load:** confirm no other llama-server is already holding the GPU (`tasklist` / check `nvidia-smi`). Only one model fits in 6GB at a time. If a model genuinely won't fit, drop `--ctx-size` to 6144 before trying a smaller quant.
- **Session hangs at "Running" forever:** shouldn't happen post-Phase-3 - every stage has a bounded timeout (viz load 90s, VLM call 120s, bridge action 30s, session wall clock 15min). If it does, check `backend` stdout for an unhandled exception; the server's crash safety net should still mark the session `error` in the DB, but a truly stuck Playwright page is the one thing that can't self-recover - restart the backend.
- **Settle timeout warnings:** shown when a dashboard update takes >12s to visually stabilize (slow Tableau Public rendering, not a bug). The step still completes with a `settle_timeout` flag; occasional ones are normal on heavier dashboards, frequent ones suggest that specific dashboard isn't a good fit for the curated list.
- **Empty inventory warning:** the dashboard has no API-operable filters/parameters/extra sheets - the agent can only answer from what's visible in the initial screenshot. Not an error, just a capability limit of that specific dashboard.
- **A dashboard has a "decoy" control:** some real-world workbooks (see Zillow above) have parameters or filters left over from authoring that aren't wired to anything visible. The loop guard + escalating corrective feedback (AGENT_PLAN.md-driven design) handles this automatically, typically converging within 2-3 extra steps - if you see a session burn most of its 15-step budget on this, that's worth investigating as a regression.
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

- **Keep-alive dashboard preview + stateful follow-ups.** Each question currently opens a fresh Playwright page and resets the dashboard to its default state (`FRONTEND_PLAN.md` D7). A version that keeps one page alive across a whole conversation, letting follow-ups build on the *current* filtered state instead of resetting, is a bigger architectural change (page lifecycle spans multiple sessions) deferred until the fresh-reset model proves insufficient in practice.
- **Token streaming.** Thoughts are revealed via a client-side typewriter, not real token-by-token streaming from the VLM - the prompt caps thoughts at ≤2 sentences and the call uses `response_format: json_object`, so there's no meaningful token stream to forward, and streaming would also break the JSON-repair retry logic.
- **Voice (STT/TTS).** Deferred per the original project plan pending the core step-by-step answering being solid first. The Watch screen's feed is built from discrete, narratable step strings (thought, action label, outcome) specifically so TTS can be layered on without restructuring the data model later.
- **Open-web dashboard search with probe-gating.** The landing page's search is client-side keyword scoring over the 5 curated, `probe.js`-validated dashboards only (D8) - arbitrary Tableau Public URLs are supported via direct paste, but there's no "search the whole internet and validate what comes back" flow.
- **Literal click crosshairs on self-generated dashboards.** The agent acts through the Tableau Embedding API, not pixel clicks, so there's no cursor position to show (D10) - a semantic action card + best-effort widget highlight is the permanent design for Tableau targets. Literal crosshairs would only become meaningful for a future self-generated-dashboard target where pixel coordinates are actually known.

## Known findings worth reading before extending this system

- **Tableau's internal iframe reuses `id="viz"`** - the embedded element uses `id="agentViz"` to avoid Playwright locator collisions.
- **Filter domain enumeration (`getDomainAsync`) works reliably** on every dashboard tested - the `domain: null` fallback path is a true edge case, not the common case.
- **`Dashboard.applyFilterAsync` broadcasts natively** to every worksheet sharing a field when the active sheet is a dashboard - no manual per-worksheet iteration needed for categorical filters. Range filters have no dashboard-level equivalent and still need per-worksheet `applyRangeFilterAsync`.
- **Real-world dashboards can have decoy/orphaned controls** - a parameter or filter that sounds relevant by name but isn't wired to anything visible (see Zillow's "Select Region" parameter vs. its real `RegionName` filter). The system recovers via loop-guard rejection + escalating corrective feedback, not by detecting decoys directly (that's not generally knowable).
- **Dense, fine-grained charts (many small icons/marks close together) are genuinely hard to verify** even by manual human inspection of a screenshot, not just for the VLM - see the `q4` disease-icon-counting case. Don't treat a model's answer on this class of question as ground truth without independent verification.
- **A dashboard's screenshot can have significant dead margin** if `sheet.size.behavior === "automatic"` (no fixed published size to auto-snap the host page to) - see CA Revenue Sources, whose real content occupies only the left ~40% of its captured frame.

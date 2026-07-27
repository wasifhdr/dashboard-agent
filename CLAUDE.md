# CLAUDE.md

Guidance for Claude Code working in this repo. Keep it accurate — if you discover the running app diverges from a doc, trust the app and fix the doc.

## What this is

A **local VLM agent that answers questions about interactive Tableau Public dashboards by operating them** (filters, parameters, tab switches) through the Tableau Embedding API v3, recording every step (reasoning + action + screenshot) into a trajectory you can watch live or replay. It's the *showcase/system* half of an NSU CSE499B senior-design project built around the **DashboardQA** benchmark (agentic VLM QA on Tableau dashboards). The user owns the system; teammates own the research (beating accuracy scores) — so prioritize demo-ability, reliability, and clarity over squeezing benchmark points.

The product is branded **"Docent"** in the frontend (UI strings only; the repo/code is "dashboard-agent").

## Layout

This folder (`dashboard-agent/`) is the project root and working directory. The **plan docs live one level up** in the parent `CSE499B.17/` and are referenced as `../` (matching the README).

```
dashboard-agent/           ← project root / working directory
  .claude/launch.json      Preview-tool config (frontend dev server; runs `npm run dev --prefix frontend`)
  README.md                phase-by-phase build history + setup/demo/troubleshooting
  backend/                 Node ESM, Express, Playwright, better-sqlite3, VLM client  (:8990)
    src/                   core modules (see map below)
    public/host.html       Tableau <tableau-viz> embed page + window.__agentBridge (Embedding API v3)
    scripts/               llama-server launchers + vision smoke test
    eval/                  questions.json, smoke-questions.json, reading/ micro-benchmark, results.csv
    config.json            llama endpoint, timeouts, settle gate, curated dashboards
    run.js probe.js eval.js  CLI entry points
  frontend/                Vite + React + Tailwind v4, "Docent" UI  (:5173)
    src/screens/           Landing/ (marketing), Watch/ (cinematic run view), History/
    src/components/        AppShell + ui/ primitives
  docs/DESIGN.md           design system ("Warm Editorial" tokens)

  ../AGENT_PLAN.md         backend build plan + contracts (Phases 0–3, all complete)  [parent dir]
  ../FRONTEND_PLAN.md      "Docent" UI revamp spec (built — Phases F0–F5)             [parent dir]
```

## Architecture & the key insight

```
React viewer (:5173) ──REST(start/list/replay)+SSE(live steps)──► Node backend (:8990)
                                                                     │ Playwright drives ONE shared long-lived browser
                                    ┌────────────────────────────────┴───────────────┐
                          host.html (<tableau-viz> + __agentBridge)          llama-server (:8080, VLM)
```

The **user's browser never embeds the Tableau viz** — Tableau renders marks to `<canvas>` inside a cross-origin iframe that page JS can't screenshot or introspect. Only Playwright (browser-automation level) can. The React viewer *only* displays frames/events streamed from the backend. Perception is visual (Playwright screenshot); grounding/actuation is structured (Embedding API v3 bridge — `getFilters`/`applyFilterAsync`, parameters, `activateSheetAsync`, `applyRangeFilterAsync`). There is no DOM to walk on Tableau.

## Running it (there is no single start script)

Three processes, ideally in this order (llama first so its ~15–25s load hides behind the others). Windows, PowerShell primary. All paths below are relative to this root.

1. **VLM** — `backend/scripts/start-llama.ps1` → llama-server on `:8080`. Wait for `main: server is listening` / `curl http://127.0.0.1:8080/health` → `{"status":"ok"}`.
2. **Backend** — from `backend/`: `npm run dev` (= `node src/server.js`) → Express + shared Playwright browser on `:8990`.
3. **Frontend** — Preview tool `preview_start({name: "frontend"})` (or from `frontend/`: `npm run dev`) → Vite on `:5173`.

Backend/frontend don't need llama-server until a session actually starts. Only one model fits in 6GB VRAM at a time — stop one llama-server before starting another.

**CLI entry points** (run from `backend/`, need only llama-server up — no UI):
- `npm run probe -- <tableau-url>` — validate a dashboard (inventory, screenshot, filter+settle+diff), no VLM.
- `npm run run-agent -- <tableau-url> "<question>"` — one agent run, streams steps to stdout.
- `npm run eval -- eval/questions.json` — batch harness → `eval/results.csv`.
- `npm run reading-bench -- --label <name>` — chart-reading micro-benchmark vs whichever model is loaded.
- `npm run vision-smoke-test -- <image.png>` — "can this model see at all" check.

## Hardware & model constraints (do not casually change)

- GPU: **RTX 4050 Laptop, 6 GB VRAM.** This caps everything at a ~4B VLM. Don't raise `--ctx-size`, quant level, or `imageLongSide` without re-checking VRAM headroom — the `start-llama.ps1` flags (ctx 8192, flash-attn on, KV `q8_0`) are pinned for 6GB with ~1.5GB headroom.
- Model files live on `E:\llama.cpp\models\` and are **not committed** (`*.gguf` gitignored). Primary = Jackrong Qwen3.5-4B Claude-Opus-reasoning distill (`...Q4_K_M_v2.gguf` + `...Q6_K_v2_mmproj.gguf`); stock comparison = Qwen3.5-4B base Q6_K. A/B result: distill 10/10 vs stock 8/10 on the reading micro-benchmark.
- Model is hot-swappable behind `config.json` `llamaEndpoint` / the `src/vlmClient.js` boundary — an API frontier VLM is the escape hatch if the local model isn't good enough.

## Backend module map (`backend/src/`)

| File | Role |
|---|---|
| `orchestrator.js` | The agent loop: perceive→inventory→prompt→validate→execute→settle→persist. Step budget (15), loop guard (exact-repeat + max-2-consecutive-waits + escalating corrective feedback), timeouts, forced best-effort answer on budget exhaustion. |
| `perception.js` | Playwright open, **settle gate**, screenshot, coarse changed-region pixel diff. |
| `inventory.js` | Normalizes controls to stable `S*`/`F*`/`P*` IDs; merges same-field filters across worksheets. |
| `vlmClient.js` | Prompt builder + image resize + `response_format: json_object` call + last-JSON-object fallback extractor (tolerates leaked `<think>`) + up to 2 re-prompts. |
| `actionSchema.js` | zod discriminated union — the 7 action types. |
| `actuator.js` | Executes a validated action against `__agentBridge`; case-insensitive domain matching + near-match suggestions; 30s timeout. |
| `store.js` | better-sqlite3 (sessions/steps), WAL, frames never deleted. Schema migrations are safe `ALTER TABLE` / table-rebuild. |
| `server.js` | Express: `POST/GET /api/sessions`, `GET /api/sessions/:id` (replay), `POST /api/sessions/:id/stop`, `/events` (SSE live), `/api/config`, `/api/dashboards/meta`, static `/frames`; plus the WebSocket screencast/input endpoint for live takeover. `adaptAndPublish()` translates internal step events into the SSE contract. One-session-at-a-time mutex. |
| `sessionBus.js` | Per-session event buffer + fan-out so a mid-run SSE client gets full replay then live. |
| `conversationRuntime.js` | **Live-takeover subsystem** (docs/LIVE_TAKEOVER_PLAN.md). Owns the ONE long-lived Playwright context/page so multiple agent turns run against the same live dashboard without reopening it, and lets a user take over that shared browser. Singleton via `getActiveRuntime`/`setActiveRuntime`; CDP screencast fanned out to WebSocket clients as base64 JPEG frames + normalized vizbox + lock/unlock signals; forwarded mouse/keyboard input under a turn-based lock (dispatched only while `mode !== 'agent'`); takeover capture (before/after frame + inventory + Tableau event-log slice, diffed and persisted to the `takeovers` table); idle timers + mode switching. Newer than the frozen agent core; built on top of it. |
| `paths.js` | Path helpers. |

## Frozen vs. mutable

Per FRONTEND_PLAN.md, the **agent core is frozen** — do not casually rewrite `vlmClient.js` prompts, `actionSchema.js`, `actuator.js`, `perception.js`, or the `eval/` sets; the frontend revamp was built strictly on top of them. Changes to these need a real reason and re-running the smoke/batch evals. The frontend (`frontend/src/`), server event plumbing, and `config.json` dashboards are the normal edit surface.

## Non-obvious gotchas (learned the hard way — don't rediscover)

- **`id="agentViz"`, never `id="viz"`** — Tableau's own internal iframe reuses `id="viz"`, causing Playwright locator collisions.
- **`Dashboard.applyFilterAsync` broadcasts natively** to every worksheet sharing a field (when the active sheet is a dashboard) — no per-worksheet iteration for categorical filters. **Range filters** have no dashboard-level equivalent — still per-worksheet `applyRangeFilterAsync`.
- **`getDomainAsync` works reliably** — the `domain: null` fallback is a true edge case, not the common path.
- **Settle gate is required** — Embedding API promises can resolve *before* render finishes (the paper's "info-retention" failure). Wait for visual stabilization before each frame. `settle_timeout` (>12s) is a flag, not a crash; frequent ones mean that dashboard is a poor fit.
- **Decoy/orphaned controls exist** in real workbooks (e.g. an unwired "Select Region" parameter sitting next to the real `RegionName` filter that actually drives the view). The loop guard + escalating corrective feedback recovers within a few steps — the system doesn't detect decoys directly (not generally knowable).
- **Dead margin** when `sheet.size.behavior === "automatic"` (no fixed published size to auto-snap to) — wastes image tokens (see the Data Science Salaries dashboard, ~40% blank on the right). The host page auto-shrinks to the real published size after `FirstInteractive` when it can.
- **Backend port dies on Windows, and Express lies about it** — this machine's TCP dynamic port range was set to 1024–15000, so Hyper-V/WinNAT auto-reservations keep landing on dev ports (8788, then 8990). A bind inside a reserved range fails `EACCES`, but `app.listen`'s callback still fires (with `address() === null`), so the backend printed a "listening" banner while serving nothing. `server.js` now gates that banner on `address()` and prints a real diagnostic. Permanent fix (restore the default dynamic range + persistently reserve 8990, admin) is in README.md → Troubleshooting. `BACKEND_PORT` overrides `config.backendPort` for both backend and Vite proxy; `hostPageOrigin` must be kept in sync (startup asserts this).
- **Dense fine-grained charts** (many small icons/marks) are genuinely hard to verify even by manual human inspection (see `q4` disease-icon counting) — don't treat a model answer on that class as ground truth without independent checking.

## Verifying a change

For anything observable in the browser, actually run it (don't just typecheck). Start the three processes, open `:5173`, pick a dashboard, ask a question, watch the Watch screen, and check `read_console_messages` + `read_network_requests` for errors. Actuation is **pixel mode** (`config.json` `actuationMode: "pixel"`, remote VLM), so demos exercise pixel perception + clicking, not the structured bridge. Fastest known-good end-to-end demo (pure reading, no click): **Video Game Sales → "In the Top 5 Publishers chart, which publisher has the highest total sales?" → expect Nintendo** (1 step). Pixel-click actuation demo (known-good): **Video Game Sales → "Click the 'Electronic Arts' bar in the Top 5 Publishers chart to filter to that publisher, then report which single game has the highest global sales in the Top 10 Games chart" → expect FIFA 15** (2 steps: one pixel-click on the big EA bar, then the answer off the re-filtered frame). Prefer large, clearly-labeled marks as click targets — clicking the *small stacked rows* in the "Top Genres" chart instead loops (10+ `rejected_loop` steps in testing) because the pixel target is too small/ambiguous.

## Git

This repo (`.git` here at the root) currently has **zero commits** despite all the work being on disk — everything is one accidental delete away from gone. Suggest committing before risky operations, and never run a destructive git/filesystem command here without flagging it first. Branch state is the user's call.

## Docs are ahead of / behind the code in places

`../FRONTEND_PLAN.md` is **built**, not pending. `README.md`'s "Deferred" section predates the frontend revamp and doesn't mention it — genuinely deferred items are keep-alive/stateful follow-ups, token streaming, voice (STT/TTS), open-web dashboard search, and literal click crosshairs. When unsure whether a feature exists, re-verify against the running app.

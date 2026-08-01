# CLAUDE.md

Guidance for Claude Code working in this repo. Keep it accurate — if the running app diverges from a doc, trust the app and fix the doc.

## What this is

An agent that answers questions about interactive Tableau Public dashboards **by operating them** — clicking marks, filtering, switching views — and records every step (reasoning + action + screenshot) into a trajectory you can watch live or replay. It's the _showcase/system_ half of an NSU CSE499B senior-design project built around the **DashboardQA** benchmark. The user owns the system; teammates own the research (accuracy scores) — so prioritize demo-ability, reliability, and clarity over squeezing benchmark points.

Branded **"Docent"** in the frontend (UI strings only; the repo/code is `dashboard-agent`).

Public repo: <https://github.com/wasifhdr/dashboard-agent>. README.md is now written for that audience — keep it public-facing, not a build log.

## The model: Gemini, pixel mode, permanently

**Actuation is pixel mode and the VLM is hosted Gemini.** `config.json` has `"actuationMode": "pixel"`, and `resolveVlmTarget` in `vlmClient.js` routes pixel mode to `config.pixel.vlmEndpoint` (`gemini-flash-lite-latest`, key read from the env var named by `vlmApiKeyEnv`). The key lives in the **repo-root** `.env` (git-ignored), loaded by `src/env.js`.

The earlier locally-hosted approach is **retired and its scaffolding deleted**: no llama.cpp, no local Qwen, no 6GB-VRAM constraints, no `llamaEndpoint`, no `backend/scripts/`. Do not reintroduce them or write docs that assume them.

`resolveVlmTarget` now has exactly one supported shape — `config.pixel.vlmEndpoint` — and **throws** if it's missing rather than falling back to a dead localhost URL. It is deliberately independent of `actuationMode`: the mode selects which system prompt gets built, not where the request goes.

Two things survive on purpose, and are genuinely live rather than vestigial:

- **`actuationMode: "api"`** — the structured-bridge prompt (operate filters/parameters by `F*`/`P*` id instead of clicking). It runs against the same hosted endpoint and still works; it's the comparison arm for the two grounding strategies. `config.json` ships `"pixel"`, and every `?? ` default in the code is now `"pixel"`.
- **`eval/reading/`** — crops and measurements from the old local models, kept as archived data. `build-crops.js` is pure image cropping and calls no model.

Use `activeModelName(config)` from `vlmClient.js` when recording which model answered — **never** `config.modelName`, which no longer exists. Sessions recorded before 2026-08-01 carry the old Qwen model id; that's history, not a bug.

## Layout

This folder is the repo root and working directory. Plan docs are in `docs/`, **inside** the repo.

```
dashboard-agent/
  .claude/launch.json      Preview-tool config (frontend dev server)
  README.md                public-facing project README
  backend/                 Node ESM, Express, Playwright, better-sqlite3  (:8990)
    src/                   core modules (see map below)
    public/host.html       <tableau-viz> embed page + window.__agentBridge
    eval/                  questions.json, smoke-questions.json, results.csv
    test/                  node:test unit tests (`npm test`)
    config.json            VLM endpoints, timeouts, settle gate, starter dashboards
    run.js probe.js eval.js  CLI entry points
  frontend/                Vite + React + Tailwind v4  (:5173)
    src/screens/           Landing/ · Watch/ · History/
    src/components/        AppShell + ui/ primitives
  docs/AGENT_PLAN.md       backend build plan + contracts (complete)
  docs/LIVE_TAKEOVER_PLAN.md  live conversation/takeover system (complete)
  docs/DESIGN.md           design system ("Warm Editorial" tokens)
  docs/superpowers/        specs + plans from planned feature work
```

`FRONTEND_PLAN.md` is referenced in places but lives **outside the repo** in the parent folder — it won't exist in a clone. Don't link to it from committed docs.

## Architecture & the key insight

```
React viewer (:5173) ──REST + SSE + WS──► Node backend (:8990)
                                            │ Playwright drives ONE shared headless Chromium
                     ┌──────────────────────┴───────────────────┐
            host.html (<tableau-viz> + __agentBridge)      Google Gemini (vision)
```

The **user's browser never embeds the Tableau viz** — Tableau paints marks to `<canvas>` inside a cross-origin iframe that page JS can't screenshot or introspect. Only Playwright (browser-automation level) can. The React viewer _only_ displays frames/events streamed from the backend.

Perception is visual (Playwright screenshot → Gemini). Actuation is by **normalized coordinate click**, refined by a zoom pass. The Embedding API bridge is still read for the control inventory, but in pixel mode that inventory is **context, not a control surface** — `vlmClient.js`'s pixel prompt explicitly tells the model it must act by clicking, not by id. Its value is vocabulary: filter domain values tell the model a value exists even when it's inside a collapsed dropdown, which sharpens the `target` string the zoom-refine pass then looks for.

## Running it

Two processes. Windows, PowerShell primary.

1. **Backend** — from `backend/`: `npm run dev` → Express + shared Playwright browser on `:8990`. The listening banner is gated on the socket actually binding; a port diagnostic instead means the bind failed (see gotchas).
2. **Frontend** — Preview tool `preview_start({name: "frontend"})`, or from `frontend/`: `npm run dev` → Vite on `:5173`.

No local model server is involved. The backend needs `GEMINI_API_KEY` in the repo-root `.env` before a run can call the VLM, but starts fine without it.

**CLI entry points** (run from `backend/`):

- `npm run probe -- <tableau-url>` — validate a dashboard (inventory, screenshot, filter+settle+diff), no VLM. Note it launches its **own** browser and **mutates state** by applying a filter — never point it at a live session's page.
- `npm run run-agent -- <tableau-url> "<question>"` — one agent run, streams steps to stdout.
- `npm run eval -- eval/questions.json` — batch harness → `eval/results.csv`.
- `npm test` — unit tests (`node --test test/*.test.js`). Prefer it over a bare `node --test`, which discovers more broadly than intended.

## Backend module map (`backend/src/`)

| File | Role |
|---|---|
| `orchestrator.js` | The agent loop: perceive→inventory→prompt→validate→execute→settle→persist. Step budget (15), loop guard (exact-repeat + max-2-consecutive-waits + dead-click radius + escalating corrective feedback), zoom-refine pass on pixel clicks, forced best-effort answer on budget exhaustion. |
| `perception.js` | Playwright open, **settle gate**, screenshot, coarse changed-region pixel diff. |
| `inventory.js` | Normalizes controls to stable `S*`/`F*`/`P*` IDs; merges same-field filters across worksheets. Returns `{activeSheet, sheets, filters, parameters}` — note it does **not** preserve `isDashboard` from the raw bridge payload. |
| `vlmClient.js` | Prompt builder (separate api/pixel system templates) + image resize + `response_format: json_object` + last-JSON-object fallback extractor + up to 2 re-prompts. `resolveVlmTarget` returns the one configured hosted endpoint or throws; `activeModelName` is the safe read for bookkeeping. |
| `actionSchema.js` | zod discriminated union — 8 action types (`set_filter`, `set_range_filter`, `set_parameter`, `switch_sheet`, `wait`, `answer`, `fail`, `click`). **None advances a story point.** |
| `actuator.js` | Executes a validated action against `__agentBridge`; case-insensitive domain matching + near-match suggestions; 30s timeout. |
| `pixelGuard.js` | Dead-click proximity guard for pixel mode. |
| `store.js` | better-sqlite3: `conversations`, `sessions` (one row per turn), `steps`, `takeovers`. WAL, frames never deleted. Migrations are guarded `ALTER TABLE` / table-rebuild. |
| `server.js` | Express: sessions + conversations REST, `/events` SSE, `/api/config`, `/api/dashboards/meta`, `/api/search`, `/api/tts`, static `/frames`, plus the WebSocket screencast/input endpoint. `adaptAndPublish()` translates internal step events into the SSE contract. One-turn-at-a-time mutex. |
| `sessionBus.js` | Per-session event buffer + fan-out so a mid-run SSE client gets full replay then live. |
| `tableauSearch.js` | Proxies Tableau Public's undocumented search endpoint; normalizes `defaultViewRepoUrl` into the `/views/<wb>/<view>` shape plus a thumbnail URL; 5-min TTL cache; degrades to `{results:[], degraded:true}` and **never** surfaces a non-200. |
| `viability.js` | Read-only post-open inspection for dashboards not in `config.dashboards`. Returns `good` / `unusable` / `unknown`. Deliberately has **no "limited" verdict** — in pixel mode a filter count doesn't predict workability, since the agent clicks marks rather than operating filter objects. |
| `conversationRuntime.js` | Owns the ONE long-lived Playwright context/page so multiple turns run against the same live dashboard without reopening it, and lets the user take over. CDP screencast → WebSocket clients as base64 JPEG + normalized vizbox + lock/unlock; forwarded input under a turn-based lock; takeover capture (before/after frame + inventory + event-log slice, persisted); idle timers; mode switching. |
| `paths.js` / `env.js` | Path helpers; repo-root `.env` loader (imported first by every entry point). |

## Frozen vs. mutable

The **agent core is frozen**: don't casually rewrite `vlmClient.js` prompts, `actionSchema.js`, `actuator.js`, `perception.js`, or the `eval/` sets. Changes there need a real reason and a re-run of the smoke/batch evals. Normal edit surface: `frontend/src/`, server event plumbing, `config.json`, and the newer modules (`tableauSearch.js`, `viability.js`, `conversationRuntime.js`).

## `config.dashboards` is a shortcut, not a class

The five entries in `config.json` are a **landing-page starting list and demo safety net** — not a privileged category the system is built around. Search and paste-a-URL open any workbook, and every module treats all URLs identically. The one exception is `viability.js` inspection being skipped for listed URLs, which is a noise optimization only. Design new features URL-agnostic; don't frame work around curated-vs-uncurated.

## Non-obvious gotchas (learned the hard way — don't rediscover)

- **`id="agentViz"`, never `id="viz"`** — Tableau's internal iframe reuses `id="viz"`, causing Playwright locator collisions.
- **`getInventory()` throws on a Tableau story** — `host.html` calls `getRawFilters()` unguarded and a Story has no `getFiltersAsync` (`TypeError: worksheets[0].getFiltersAsync is not a function`). Detect a story by reading `activeSheet.sheetType` off the element **before** touching the bridge, as `viability.js` does.
- **`waitForSettle` RETURNS `{settled, timedOut}` — it does not throw on timeout.** Discard that value and you'll screenshot a still-painting dashboard. This caused a real bug where slow-but-healthy dashboards were reported as blank.
- **Settle gate is required** — Embedding API promises resolve _before_ render finishes. `settle_timeout` (>12s) is a flag, not a crash; frequent ones mean a poor-fit dashboard.
- **`Dashboard.applyFilterAsync` broadcasts natively** to every worksheet sharing a field (when the active sheet is a dashboard). **Range filters** have no dashboard-level equivalent — still per-worksheet.
- **`getDomainAsync` works reliably** — `domain: null` is a true edge case, not the common path.
- **Decoy/orphaned controls exist** in real workbooks (an unwired "Select Region" parameter next to the real `RegionName` filter). Loop guard + escalating feedback recovers; decoys aren't directly detectable.
- **Dead margin** when `sheet.size.behavior === "automatic"` — no published size to snap to, so frames waste image tokens. The host page auto-shrinks when it can.
- **Backend port dies on Windows, and Express lies about it** — Hyper-V/WinNAT auto-reservations land on dev ports; a bind inside a reserved range fails `EACCES` but `app.listen`'s callback **still fires** with `address() === null`. `server.js` gates the banner on `address()`. Permanent fix in README → Troubleshooting. `BACKEND_PORT` overrides `config.backendPort` for backend and Vite proxy alike; `hostPageOrigin` must stay in sync (startup asserts this).
- **The Browser pane can't test debounce** — synthetic keystrokes land 4–11s apart, exceeding any debounce in the app. Verify debounce by reading code, never by counting requests.
- **Dense fine-grained charts** are hard to verify even by manual human inspection — don't treat a model answer on that class as ground truth.

## Verifying a change

For anything observable in the browser, actually run it (don't just typecheck). Start both processes, open `:5173`, pick a dashboard, ask a question, watch the Watch screen, and check `read_console_messages` + `read_network_requests`.

Known-good demos:

- **Pure reading, 1 step** — Video Game Sales → _"In the Top 5 Publishers chart, which publisher has the highest total sales?"_ → **Nintendo**
- **Pixel-click actuation, 2 steps** — Video Game Sales → _"Click the 'Electronic Arts' bar in the Top 5 Publishers chart to filter to that publisher, then report which single game has the highest global sales in the Top 10 Games chart"_ → **FIFA 15**
- **Viability banner** — paste `https://public.tableau.com/views/HartfordYoungChildrenDataStory/DataStory` → verified story; expect the coral banner and `[viability] ... -> unusable ["story"]` in the backend log

Prefer large, clearly-labeled click targets. The small stacked rows in "Top Genres" loop (10+ `rejected_loop` steps observed) because the target is too small and ambiguous.

## Git

Real committed history — check `git log` before assuming anything about repo state. The branch is **`main`**, tracking `origin/main` at <https://github.com/wasifhdr/dashboard-agent> (older notes and the SDD ledger say `master`; it was renamed). Work happens directly on it by the user's standing preference.

Suggest committing before risky operations, stage only the files a change actually touches (never `git add -A`), and never run a destructive git/filesystem command without flagging it first. Pushing is public — only on an explicit ask.

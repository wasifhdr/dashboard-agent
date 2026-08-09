# Discoveries Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a session-scoped memory of hard facts it has read off the dashboard, so multi-reading questions stop looping and re-reading what the agent already knows.

**Architecture:** The model authors a `discovery` string as a third key in its existing JSON response. Each accepted discovery is stamped with the filter state it was read under and appended to an in-memory log that lives on the `conversationRuntime` object — so it spans every turn on one dashboard and is garbage-collected when the conversation closes. The whole log is re-rendered into every subsequent prompt under a `CONFIRMED DISCOVERIES` block.

**Tech Stack:** Node 20 ESM, zod, better-sqlite3, Express + SSE, Playwright, React 18 + Vite + Tailwind v4, `node:test`.

**Spec:** [docs/superpowers/specs/2026-08-09-discoveries-memory-design.md](../specs/2026-08-09-discoveries-memory-design.md)

## Global Constraints

- **Working directory for all backend commands is `backend/`.** Frontend commands run from `frontend/`. Git commands run from the repo root.
- **Windows / PowerShell.** `&&` is not a valid PowerShell operator — run commands one per line, or use the Bash tool.
- **Run `npm test`, never a bare `node --test`.** The npm script is `node --test test/*.test.js`; a bare `node --test` discovers more broadly than intended.
- **Never `git add -A`.** Stage only the files a task actually touches. The working tree already contains an unrelated deletion (`bungee.shade-regular.otf`) that must not be committed.
- **Branch is `main`** and work happens directly on it. Do not push — pushing is public and needs an explicit ask.
- **`actionSchema.js`, `vlmClient.js` and `orchestrator.js` are frozen core.** They fail *silently*: a regression there degrades answer quality without throwing, so no unit test catches it. Tasks 3, 4 and 6 touch them and are gated on the eval accuracy comparison in Task 10, not on tests passing.
- **`id="agentViz"`, never `id="viz"`** if any Playwright locator work comes up.
- **Discovery text cap is 200 characters. Log cap is 40 entries. Stamp cap is 3 entries / 80 characters.** These exact numbers appear in several tasks; they must match.
- **The label format is `[T{turnIndex+1}#{stepIdx} | {stamp}]`** — turn part omitted when `turnIndex` is null, stamp part omitted when the stamp is empty.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `backend/src/discoveries.js` | The log: normalization, dedupe, cap, formatting, and the inventory→stamp derivation. Pure, no I/O. |
| `backend/src/evalMatch.js` | `matchesExpect` extracted out of `eval.js` so it can be unit-tested. |
| `backend/test/discoveries.test.js` | Unit tests for the above. |
| `backend/test/evalMatch.test.js` | Unit tests for the matcher primitives. |
| `backend/eval/memory-questions.json` | The four DashboardQA multi-hop questions. |

**Modified**

| File | Change |
|---|---|
| `backend/src/actionSchema.js` | `discovery` field on `StepResponseSchema` |
| `backend/src/vlmClient.js` | Both system templates, `buildPrompt` block, discovery normalization, `getNextAction` return |
| `backend/src/orchestrator.js` | `discoveryLog` opt, recording, persist + emit, `forceBestEffortAnswer` |
| `backend/src/store.js` | `steps.discovery` column |
| `backend/src/conversationRuntime.js` | Owns the log |
| `backend/src/server.js` | Passes the log in, takeover note, SSE field, trajectory field |
| `backend/eval.js` | URL normalization, imports `evalMatch.js` |
| `backend/run.js` | URL normalization |
| `frontend/src/screens/Watch/useSessionStream.js` | Carries `discovery` through live + replay |
| `frontend/src/screens/Watch/Feed.jsx` | Renders it |
| `frontend/src/screens/Watch/warningLabels.js` | Label for the new warning kind |
| `CLAUDE.md` | Module map, frozen-core note, eval-harness notes |

---

### Task 1: Capture the baseline and author the memory question set

Nothing here changes agent behavior. The deliverable is a **recorded measurement** plus a question set that can run at all — both must exist before any code changes, or the eval delta later is meaningless.

**Files:**
- Create: `backend/eval/memory-questions.json`
- Modify: `backend/run.js`
- Modify: `backend/eval.js`

**Interfaces:**
- Consumes: nothing
- Produces: `backend/eval/memory-questions.json`; a recorded baseline accuracy number used as the gate in Task 10

- [ ] **Step 1: Record the current accuracy baseline**

Run from `backend/`:

```bash
npm run eval -- eval/questions.json
```

Expected: it prints `Accuracy: n/m scored correct`. **Write that `n/m` down** — paste it into the commit message in Step 8 and into the Task 10 gate. This takes several minutes and costs VLM calls; do not skip it, and do not re-derive it later from a different run.

- [ ] **Step 2: Add URL normalization to `run.js`**

The four DashboardQA URLs are in the `/app/profile/…/viz/…` browse form. `<tableau-viz>` cannot load that form, and both forms return HTTP 200, so an un-normalized URL silently burns the 90s open timeout. Only `server.js` normalizes today.

In `backend/run.js`, add the import after the existing `runSession` import on line 10:

```js
import { normalizeTableauViewUrl } from "./src/tableauUrl.js";
```

Then replace the arg-parsing block (lines 15–19):

```js
const [, , vizUrlRaw, question] = process.argv;
if (!vizUrlRaw || !question) {
  console.error('Usage: node run.js <tableau-url> "<question>"');
  process.exit(1);
}
// Tableau Public shows /app/profile/<p>/viz/<wb>/<view> in the address bar, so
// that is the URL a user copies - but only /views/<wb>/<view> embeds. Both
// return 200, so an un-rewritten browse URL just burns the 90s open timeout.
const { url: vizUrl, rewritten } = normalizeTableauViewUrl(vizUrlRaw);
if (rewritten) console.log(`Rewrote browse URL to embed form: ${vizUrl}`);
```

`vizUrl` is already the name passed to `runSession` on line 56, so no other change is needed there.

- [ ] **Step 3: Add URL normalization to `eval.js`**

In `backend/eval.js`, add the import after line 23:

```js
import { normalizeTableauViewUrl } from "./src/tableauUrl.js";
```

Then inside the `for (const [i, q] of questions.entries())` loop, immediately after `const startedAt = Date.now();` (line 79), add:

```js
    // Question files keep the dataset's URL verbatim for provenance; the
    // embed-form rewrite happens here at run time. See tableauUrl.js.
    const { url: dashboardUrl } = normalizeTableauViewUrl(q.dashboard_url);
```

And change the `runSession` call's URL argument (line 89) from `dashboardUrl: q.dashboard_url,` to:

```js
        dashboardUrl,
```

Leave the CSV row's `q.dashboard_url` (line 120) alone — the CSV should record the URL as the file states it.

- [ ] **Step 4: Verify normalization works without spending a full eval run**

Run from `backend/`:

```bash
node -e "import('./src/tableauUrl.js').then(m=>console.log(m.normalizeTableauViewUrl('https://public.tableau.com/app/profile/chloedotbrown/viz/AirBnBinEastvs_WestBerlin/AirBnBBerlin')))"
```

Expected output:

```
{ url: 'https://public.tableau.com/views/AirBnBinEastvs_WestBerlin/AirBnBBerlin', rewritten: true }
```

- [ ] **Step 5: Create the memory question set**

Create `backend/eval/memory-questions.json`:

```json
{
  "source": "DashboardQA",
  "verified_on": "2026-08-09",
  "note": "Multi-hop questions that cannot be answered without carrying a reading across steps. Ground truth comes from the DashboardQA dataset, NOT from our own inspection of a live capture - so it can rot exactly like eval/questions.json, and additionally may not match how these particular workbooks render today. Dashboard URLs are kept verbatim in the dataset's browse form; eval.js rewrites them to the embed form at run time. Every entry starts scored:false: expect values are written only after observing the answer text the agent actually produces (see docs/superpowers/plans/2026-08-09-discoveries-memory.md Task 10).",
  "questions": [
    {
      "id": "berlin-beds-compare",
      "dashboard_url": "https://public.tableau.com/app/profile/chloedotbrown/viz/AirBnBinEastvs_WestBerlin/AirBnBBerlin",
      "question": "Is the average number of beds for Houses higher than that of All types, Apartments, and Hotels/Hostels?",
      "expected_answer": "No",
      "scored": false
    },
    {
      "id": "energy-growth-compare",
      "dashboard_url": "https://public.tableau.com/app/profile/alexandervar/viz/EnergyConsumptionAnimated/EnergyConsumption",
      "question": "If both nuclear and natural gas consumption increased from 1960 to 2010, which one grew faster during that time based on the charts?",
      "expected_answer": "Natural gas",
      "scored": false
    },
    {
      "id": "crsi-pledges-metro-vs-regional",
      "dashboard_url": "https://public.tableau.com/app/profile/refugee.council.of.australia/viz/CRSIPledges/CRSIPledges",
      "question": "Between NSW, QLD, and TAS State, can you list which of these have more pledges that states 'I am interested in providing friendship or recreational activities', and 'I am interested in helping a refugee get set up with school enrolments opening bank accounts, transport etc', in the 'Metropolitan' compared to 'Regional' location?",
      "expected_answer": "NSW, QLD",
      "scored": false
    },
    {
      "id": "cities-rental-fluctuation",
      "dashboard_url": "https://public.tableau.com/app/profile/olivier.maene8069/viz/Citiesv2_2-Econ/Econ_Dashboard2",
      "question": "Between the trends in office rental growth and retail rental growth from 2017-2022, which one fluctuates more?",
      "expected_answer": "Office Rental Growth",
      "scored": false
    }
  ]
}
```

- [ ] **Step 6: Run the memory set to capture pre-change behavior**

Run from `backend/`:

```bash
npm run eval -- eval/memory-questions.json
```

Expected: all four report `-` (unscored, because `scored: false`), and the harness prints `4 questions, 0 harness-level crash(es)`. What matters is that **all four dashboards open** — no `Dashboard failed to load` and no `crash`. If a dashboard fails to open, that question is unusable as a gate; note which one and raise it before continuing, rather than silently dropping it.

- [ ] **Step 7: Save the answers for later**

Copy `backend/eval/results.csv` to `backend/eval/results-baseline-memory.csv`. Task 10 compares against it, and `results.csv` is overwritten by every run.

```bash
cp eval/results.csv eval/results-baseline-memory.csv
```

- [ ] **Step 8: Commit**

`results-baseline-memory.csv` is a measurement worth keeping in history.

```bash
git add backend/run.js backend/eval.js backend/eval/memory-questions.json backend/eval/results-baseline-memory.csv
git commit -m "Add the multi-hop eval set, and make the CLIs accept browse URLs

The existing eval set has nine scored questions and not one of them needs a
value carried across steps, so it can prove 'no regression' but can never
prove the memory feature works. These four DashboardQA rows can only be
answered by remembering earlier readings.

eval.js and run.js passed dashboard_url to runSession raw - only server.js
normalized it. All four dataset URLs are in the /app/profile browse form,
which does not embed and returns 200 anyway, so they would each have burned
the 90s open timeout and failed for an invisible reason.

Baseline before any behavior change: eval/questions.json scored <N/M>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Replace `<N/M>` with the number recorded in Step 1.

---

### Task 2: The discoveries module

**Files:**
- Create: `backend/src/discoveries.js`
- Test: `backend/test/discoveries.test.js`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces:
  - `normalizeDiscoveryText(value, maxChars = 200) → string | null`
  - `stampFromInventory(inventory) → string` (`""` when nothing narrows)
  - `createDiscoveryLog({ maxEntries = 40, maxChars = 200 }) → { add, addNote, format, entries, size }`
  - `add({ text, turnIndex, stepIdx, stateStamp }) → { accepted, reason, evicted, text }` where `reason` is one of `"empty" | "none" | "duplicate" | null`
  - `format() → string` — the full `CONFIRMED DISCOVERIES` block, or `""` when the log is empty

- [ ] **Step 1: Write the failing tests**

Create `backend/test/discoveries.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createDiscoveryLog, normalizeDiscoveryText, stampFromInventory } from "../src/discoveries.js";

// --- normalizeDiscoveryText ------------------------------------------------

test("a plain fact is kept, with whitespace collapsed", () => {
  assert.equal(normalizeDiscoveryText("  House avg   beds = 3.3 "), "House avg beds = 3.3");
});

test("null-equivalents the model emits all become null", () => {
  for (const v of ["None", "none.", " NONE ", "n/a", "nothing", "-", "", null, undefined]) {
    assert.equal(normalizeDiscoveryText(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("a model echoing the field label has it stripped", () => {
  assert.equal(normalizeDiscoveryText("Discovery: Apartment avg beds = 3.8"), "Apartment avg beds = 3.8");
});

test("REGRESSION: a label with nothing after it is null, not the bare label", () => {
  assert.equal(normalizeDiscoveryText("Discovery: None"), null);
});

test("non-string shapes are coerced rather than dropped", () => {
  assert.equal(normalizeDiscoveryText(42), "42");
  assert.equal(normalizeDiscoveryText(["a = 1", "b = 2"]), "a = 1; b = 2");
});

test("an over-long discovery is truncated to the cap, total length included", () => {
  const out = normalizeDiscoveryText("x".repeat(500));
  assert.equal(out.length, 200);
  assert.ok(out.endsWith("…"));
});

// --- stampFromInventory ----------------------------------------------------

const EMPTY_INV = { activeSheet: "S", sheets: [{ id: "S1", name: "S", active: true }], filters: [], parameters: [] };

test("an inventory with nothing narrowed produces no stamp", () => {
  assert.equal(stampFromInventory(EMPTY_INV), "");
  assert.equal(stampFromInventory(null), "");
});

test("a narrowed categorical filter is stamped", () => {
  const inv = {
    ...EMPTY_INV,
    filters: [{ id: "F1", field: "Property Type", type: "categorical", applied: ["House"], domain: ["House", "Apartment", "Hotel"] }],
  };
  assert.equal(stampFromInventory(inv), "Property Type=House");
});

test("REGRESSION: a filter showing its whole domain is NOT stamped", () => {
  // It narrows nothing, so it says nothing about the state the reading was
  // taken under - stamping it would be pure noise on every entry.
  const inv = {
    ...EMPTY_INV,
    filters: [{ id: "F1", field: "Type", type: "categorical", applied: ["A", "B"], domain: ["A", "B"] }],
  };
  assert.equal(stampFromInventory(inv), "");
});

test("a range filter is stamped only when it differs from its domain", () => {
  const atDomain = {
    ...EMPTY_INV,
    filters: [{ id: "F1", field: "Year", type: "range", appliedMin: 2000, appliedMax: 2020, domainMin: 2000, domainMax: 2020 }],
  };
  assert.equal(stampFromInventory(atDomain), "");

  const narrowed = { ...atDomain, filters: [{ ...atDomain.filters[0], appliedMin: 2015 }] };
  assert.equal(stampFromInventory(narrowed), "Year=[2015..2020]");
});

test("the active sheet is stamped only when there is more than one", () => {
  const multi = {
    activeSheet: "ZRI",
    sheets: [
      { id: "S1", name: "ZHVI", active: false },
      { id: "S2", name: "ZRI", active: true },
    ],
    filters: [],
    parameters: [],
  };
  assert.equal(stampFromInventory(multi), "sheet=ZRI");
});

test("a set parameter is stamped", () => {
  const inv = { ...EMPTY_INV, parameters: [{ id: "P1", name: "Measure", type: "list", current: "Profit" }] };
  assert.equal(stampFromInventory(inv), "Measure=Profit");
});

test("the stamp is capped at three entries", () => {
  const filters = ["A", "B", "C", "D"].map((f, i) => ({
    id: `F${i + 1}`,
    field: f,
    type: "categorical",
    applied: ["x"],
    domain: ["x", "y"],
  }));
  const stamp = stampFromInventory({ ...EMPTY_INV, filters });
  assert.equal(stamp.split(", ").length, 3);
  assert.ok(!stamp.includes("D="));
});

// --- createDiscoveryLog ----------------------------------------------------

test("an empty log formats to the empty string, not a header", () => {
  assert.equal(createDiscoveryLog().format(), "");
});

test("an accepted discovery is labeled with turn, step and stamp", () => {
  const log = createDiscoveryLog();
  const r = log.add({ text: "House avg beds = 3.3", turnIndex: 0, stepIdx: 3, stateStamp: "Property Type=House" });
  assert.equal(r.accepted, true);
  assert.ok(log.format().includes("[T1#3 | Property Type=House] House avg beds = 3.3"));
});

test("a standalone run (no turnIndex) drops the turn part of the label", () => {
  const log = createDiscoveryLog();
  log.add({ text: "avg = 1", turnIndex: null, stepIdx: 2, stateStamp: "" });
  assert.ok(log.format().includes("[#2] avg = 1"));
});

test("null-equivalent and empty text are rejected with distinct reasons", () => {
  const log = createDiscoveryLog();
  assert.deepEqual(
    { accepted: log.add({ text: "None" }).accepted, reason: log.add({ text: "None" }).reason },
    { accepted: false, reason: "none" },
  );
  assert.equal(log.add({ text: "" }).reason, "empty");
  assert.equal(log.size(), 0);
});

test("REGRESSION: the same text under a DIFFERENT stamp is not a duplicate", () => {
  // "avg beds = 3.3" read under House and under Apartment are different facts.
  // Deduping on raw text alone would silently discard the second reading and
  // leave the agent unable to compare them - the exact failure this exists for.
  const log = createDiscoveryLog();
  assert.equal(log.add({ text: "avg beds = 3.3", stepIdx: 1, stateStamp: "Type=House" }).accepted, true);
  assert.equal(log.add({ text: "avg beds = 3.3", stepIdx: 4, stateStamp: "Type=Apartment" }).accepted, true);
  assert.equal(log.size(), 2);
});

test("the same text under the same stamp is a duplicate", () => {
  const log = createDiscoveryLog();
  log.add({ text: "avg beds = 3.3", stepIdx: 1, stateStamp: "Type=House" });
  const second = log.add({ text: "AVG BEDS = 3.3", stepIdx: 5, stateStamp: "Type=House" });
  assert.deepEqual({ accepted: second.accepted, reason: second.reason }, { accepted: false, reason: "duplicate" });
  assert.equal(log.size(), 1);
});

test("the cap evicts oldest-first and reports it", () => {
  const log = createDiscoveryLog({ maxEntries: 3 });
  for (const n of [1, 2, 3]) assert.equal(log.add({ text: `fact ${n}`, stepIdx: n }).evicted, false);
  const fourth = log.add({ text: "fact 4", stepIdx: 4 });
  assert.equal(fourth.evicted, true);
  assert.equal(log.size(), 3);
  assert.ok(!log.format().includes("fact 1"));
  assert.ok(log.format().includes("fact 4"));
});

test("a note sits in chronological order, unlabeled, and is exempt from dedupe", () => {
  const log = createDiscoveryLog();
  log.add({ text: "first", stepIdx: 1 });
  log.addNote("the user changed the dashboard here");
  log.addNote("the user changed the dashboard here");
  log.add({ text: "second", stepIdx: 2 });
  const lines = log.format().split("\n");
  assert.equal(lines[1], "[#1] first");
  assert.equal(lines[2], "the user changed the dashboard here");
  assert.equal(lines[3], "the user changed the dashboard here");
  assert.equal(lines[4], "[#2] second");
});

test("entries() returns copies, so a caller cannot mutate the log", () => {
  const log = createDiscoveryLog();
  log.add({ text: "fact", stepIdx: 1 });
  log.entries()[0].text = "tampered";
  assert.ok(log.format().includes("fact"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`:

```bash
node --test test/discoveries.test.js
```

Expected: FAIL — `Cannot find module '../src/discoveries.js'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/discoveries.js`:

```js
// Session-scoped memory of hard facts the model has read off the dashboard.
//
// Every VLM call is stateless - vlmClient.js rebuilds both messages from
// scratch each step - and HISTORY records ACTIONS, not FINDINGS. Before this
// module the agent had no way to carry a number from one screenshot to the
// next, so any question needing more than one reading looped until the step
// budget ran out. See
// docs/superpowers/specs/2026-08-09-discoveries-memory-design.md.
//
// Pure and I/O-free on purpose, like activeConversation.js and pixelGuard.js:
// the whole thing is unit-testable without Playwright, Express or a VLM.

const HEADER =
  "CONFIRMED DISCOVERIES (facts you established earlier this session — trust them, do not re-derive):";

// What a model writes when it means "nothing new here". Matched after the
// label strip and whitespace collapse, so "Discovery: None." lands too.
const NULL_EQUIVALENTS = new Set(["none", "n/a", "na", "nothing", "null", "-", "—"]);

const STAMP_MAX_ENTRIES = 3;
const STAMP_MAX_CHARS = 80;

// Returns the cleaned fact, or null when the model reported nothing. Total
// output length never exceeds maxChars, ellipsis included.
export function normalizeDiscoveryText(value, maxChars = 200) {
  if (value == null) return null;
  let t = Array.isArray(value) ? value.join("; ") : String(value);
  t = t.replace(/^\s*discovery\s*:\s*/i, ""); // the model echoing the field label
  t = t.replace(/\s+/g, " ").trim();
  const bare = t.toLowerCase().replace(/[.!]+$/, "");
  if (bare === "" || NULL_EQUIVALENTS.has(bare)) return null;
  return t.length > maxChars ? t.slice(0, maxChars - 1).trimEnd() + "…" : t;
}

// The filter state a reading was taken under, as a compact prefix.
//
// A number read off a dashboard is only meaningful together with the state it
// was read under. The model is told to self-qualify ("House avg beds = 3.3"),
// but it will not always comply - so we stamp deterministically from the
// inventory the orchestrator already holds for that exact frame. An
// unqualified "avg beds = 3.3" then still lands usable instead of poisoning
// every later step.
//
// Only NARROWED state is included: a filter showing its whole domain
// constrains nothing, and stamping it would put noise on every entry.
export function stampFromInventory(inventory) {
  if (!inventory) return "";
  const parts = [];

  if (Array.isArray(inventory.sheets) && inventory.sheets.length > 1) {
    const active = inventory.sheets.find((s) => s.active);
    if (active?.name) parts.push(`sheet=${active.name}`);
  }

  for (const p of (inventory.parameters ?? []).slice(0, 2)) {
    if (p.current === undefined || p.current === null || p.current === "") continue;
    parts.push(`${p.name}=${p.current}`);
  }

  for (const f of inventory.filters ?? []) {
    if (f.type === "categorical") {
      if (!Array.isArray(f.applied) || f.applied.length === 0 || f.applied.length > 3) continue;
      if (Array.isArray(f.domain) && f.applied.length >= f.domain.length) continue;
      parts.push(`${f.field}=${f.applied.join("|")}`);
    } else if (f.type === "range") {
      if (f.appliedMin == null && f.appliedMax == null) continue;
      if (f.appliedMin === f.domainMin && f.appliedMax === f.domainMax) continue;
      parts.push(`${f.field}=[${f.appliedMin ?? "?"}..${f.appliedMax ?? "?"}]`);
    }
  }

  const kept = parts.slice(0, STAMP_MAX_ENTRIES).join(", ");
  return kept.length > STAMP_MAX_CHARS ? kept.slice(0, STAMP_MAX_CHARS - 1) + "…" : kept;
}

function labelFor(entry) {
  if (entry.kind === "note") return null;
  const turn = entry.turnIndex == null ? "" : `T${entry.turnIndex + 1}`;
  const step = entry.stepIdx == null ? "" : `#${entry.stepIdx}`;
  const head = `${turn}${step}`;
  if (!head && !entry.stateStamp) return null;
  if (!entry.stateStamp) return `[${head}]`;
  if (!head) return `[${entry.stateStamp}]`;
  return `[${head} | ${entry.stateStamp}]`;
}

export function createDiscoveryLog({ maxEntries = 40, maxChars = 200 } = {}) {
  const entries = [];

  function evictToCap() {
    let evicted = false;
    while (entries.length > maxEntries) {
      entries.shift();
      evicted = true;
    }
    return evicted;
  }

  function add({ text, turnIndex = null, stepIdx = null, stateStamp = "" }) {
    const normalized = normalizeDiscoveryText(text, maxChars);
    if (normalized === null) {
      const raw = String(text ?? "").trim();
      return { accepted: false, reason: raw === "" ? "empty" : "none", evicted: false, text: null };
    }

    // Keyed on the STAMPED form: the same text under a different filter state
    // is a genuinely different fact, and collapsing the two would destroy
    // exactly the comparison this feature exists to enable.
    const key = `${stateStamp}|${normalized}`.toLowerCase();
    if (entries.some((e) => e.kind === "fact" && e.key === key)) {
      return { accepted: false, reason: "duplicate", evicted: false, text: null };
    }

    entries.push({ kind: "fact", text: normalized, turnIndex, stepIdx, stateStamp, key });
    return { accepted: true, reason: null, evicted: evictToCap(), text: normalized };
  }

  // An unlabeled line in the same chronological stream - used to mark that a
  // human changed the dashboard between turns, so readings above it are not
  // silently trusted as describing the current state. Exempt from dedupe:
  // two takeovers really are two events.
  function addNote(text) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return { accepted: false, reason: "empty", evicted: false };
    entries.push({ kind: "note", text: t, turnIndex: null, stepIdx: null, stateStamp: "", key: null });
    return { accepted: true, reason: null, evicted: evictToCap() };
  }

  // Omitted entirely when empty rather than rendered as "(none)": an empty
  // labeled section costs tokens and invites the model to fill it.
  function format() {
    if (entries.length === 0) return "";
    const lines = entries.map((e) => {
      const label = labelFor(e);
      return label ? `${label} ${e.text}` : e.text;
    });
    return `${HEADER}\n${lines.join("\n")}`;
  }

  return {
    add,
    addNote,
    format,
    entries: () => entries.map((e) => ({ ...e })),
    size: () => entries.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/discoveries.test.js
```

Expected: PASS, all tests.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS. Nothing else imports this module yet, so nothing else can break.

- [ ] **Step 6: Commit**

```bash
git add backend/src/discoveries.js backend/test/discoveries.test.js
git commit -m "Add the discoveries log, keyed on the state a reading was taken under

Pure module, no wiring yet. The load-bearing decision is the dedupe key: it
is the STAMPED form, not the raw text. \"avg beds = 3.3\" read under House and
under Apartment are different facts, and collapsing them would destroy the
exact comparison this exists to enable.

stampFromInventory only reports NARROWED state. A filter showing its whole
domain constrains nothing, so stamping it would put noise on every entry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Accept `discovery` in the response schema

**Files:**
- Modify: `backend/src/actionSchema.js:67-70`
- Modify: `backend/src/vlmClient.js` (normalization + `getNextAction` return)
- Test: `backend/test/discoveries.test.js` (append)

**Interfaces:**
- Consumes: `normalizeDiscoveryText` from Task 2
- Produces: `getNextAction(...)` now resolves to `{ valid, discovery, thought, action, rawText, attempts }` — `discovery` is `string | null`, never `undefined`, on both the success and failure returns

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/discoveries.test.js`:

```js
// --- StepResponseSchema tolerance ------------------------------------------

import { StepResponseSchema } from "../src/actionSchema.js";

const VALID_STEP = { thought: "Reading the chart.", action: { type: "wait" } };

test("REGRESSION: a response with no discovery field still validates", () => {
  // Making the field required would turn a cosmetic omission into an
  // invalid_json step, and three of those in a row end the run. In a module
  // that fails silently, a new field must not be able to do that.
  assert.equal(StepResponseSchema.safeParse(VALID_STEP).success, true);
});

test("an explicit null discovery validates", () => {
  assert.equal(StepResponseSchema.safeParse({ ...VALID_STEP, discovery: null }).success, true);
});

test("a string discovery validates and is preserved", () => {
  const out = StepResponseSchema.safeParse({ ...VALID_STEP, discovery: "House avg beds = 3.3" });
  assert.equal(out.success, true);
  assert.equal(out.data.discovery, "House avg beds = 3.3");
});
```

- [ ] **Step 2: Run to verify the first test fails**

```bash
node --test test/discoveries.test.js
```

Expected: the three new tests currently PASS for the wrong reason — zod strips unknown keys by default, so `discovery: "..."` parses but `out.data.discovery` is `undefined`. The third test FAILS with `Expected values to be strictly equal: undefined !== 'House avg beds = 3.3'`. That is the failure that matters.

- [ ] **Step 3: Add the field to the schema**

In `backend/src/actionSchema.js`, replace lines 65–70:

```js
// Generous cap, not a strict sentence-count check - the "<=2 sentences" rule
// is enforced via the prompt, not technically here.
export const StepResponseSchema = z.object({
  // Optional AND nullable on purpose. A required field would turn a cosmetic
  // omission into an invalid_json step, and three of those in a row end the
  // run - see orchestrator.js's invalidCount. The prompt asks for it every
  // turn; the schema must never punish a model that forgets.
  discovery: z.union([z.string(), z.null()]).optional(),
  thought: z.string().min(1).max(600),
  action: ActionSchema,
});
```

- [ ] **Step 4: Normalize the discovery before validation in `vlmClient.js`**

Add the import next to the existing `actionSchema` import at the top of `backend/src/vlmClient.js`:

```js
import { normalizeDiscoveryText } from "./discoveries.js";
```

In `getNextAction`, find the click-rescue block (around line 533) and add the discovery normalization immediately after it, before `safeParse`:

```js
    // Rescue right-digits/wrong-magnitude click coordinates before validating,
    // so a usable aim isn't thrown away over its units (see normalizeClickAction).
    if (parsed?.action?.type === "click") {
      parsed.action = normalizeClickAction(parsed.action, await frameDims());
    }

    // Normalized BEFORE validation, so a model that writes "None", echoes the
    // field label, or returns a number can never fail the schema over it.
    if (parsed && typeof parsed === "object") {
      parsed.discovery = normalizeDiscoveryText(parsed.discovery);
    }
```

- [ ] **Step 5: Return the discovery from both exits of `getNextAction`**

Change the success return (around line 539) to:

```js
      return {
        valid: true,
        discovery: result.data.discovery ?? null,
        thought: result.data.thought,
        action: result.data.action,
        rawText: raw,
        attempts: attempt,
      };
```

And the failure return at the end of the function (around line 549) to:

```js
  return {
    valid: false,
    discovery: null,
    thought: null,
    action: null,
    rawText: lastRaw,
    attempts: 3,
    errorKind: lastNetworkError ? "vlm_error" : "invalid_json",
    errorMessage: lastNetworkError ? lastNetworkError.message : null,
  };
```

- [ ] **Step 6: Run the tests**

```bash
npm test
```

Expected: PASS, including the three new schema tests.

- [ ] **Step 7: Commit**

```bash
git add backend/src/actionSchema.js backend/src/vlmClient.js backend/test/discoveries.test.js
git commit -m "Let the model report a discovery in its step response

Optional and nullable, and normalized before validation rather than after: a
model that writes \"None\", echoes the field label, or returns a number must
never fail the schema over it. A schema failure costs a whole step here, and
three in a row end the run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Put discoveries in the prompt

**Files:**
- Modify: `backend/src/vlmClient.js` (both system templates, `buildPrompt`, `getNextAction` signature, `_internal`)
- Test: `backend/test/prompt.test.js` (create)

**Interfaces:**
- Consumes: nothing new
- Produces: `buildPrompt({ question, inventory, history, discoveries, correctiveFeedback, mode })` — `discoveries` is a **pre-formatted string** (the output of `log.format()`), not the log object, so `vlmClient.js` stays decoupled from it. `getNextAction` takes the same `discoveries` string and passes it through.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/prompt.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { _internal } from "../src/vlmClient.js";

const { buildPrompt } = _internal;

const INV = {
  activeSheet: "Dash",
  sheets: [{ id: "S1", name: "Dash", type: "dashboard", active: true }],
  filters: [],
  parameters: [],
};

const BASE = { question: "Which is highest?", inventory: INV, history: [], mode: "pixel" };

test("the discoveries block is omitted entirely when there are none", () => {
  const { userText } = buildPrompt({ ...BASE, discoveries: "" });
  assert.ok(!userText.includes("CONFIRMED DISCOVERIES"));
});

test("the discoveries block is rendered verbatim when present", () => {
  const block = "CONFIRMED DISCOVERIES (x):\n[T1#3] House avg beds = 3.3";
  const { userText } = buildPrompt({ ...BASE, discoveries: block });
  assert.ok(userText.includes("[T1#3] House avg beds = 3.3"));
});

test("discoveries sit after HISTORY and before FEEDBACK", () => {
  const { userText } = buildPrompt({
    ...BASE,
    discoveries: "CONFIRMED DISCOVERIES (x):\n[#1] a = 1",
    correctiveFeedback: "Try again.",
  });
  const h = userText.indexOf("HISTORY:");
  const d = userText.indexOf("CONFIRMED DISCOVERIES");
  const f = userText.indexOf("FEEDBACK ON YOUR LAST RESPONSE:");
  assert.ok(h < d, "HISTORY must come before CONFIRMED DISCOVERIES");
  assert.ok(d < f, "CONFIRMED DISCOVERIES must come before FEEDBACK");
});

test("both system templates document the discovery field", () => {
  for (const mode of ["pixel", "api"]) {
    const { systemText } = buildPrompt({ ...BASE, mode, discoveries: "" });
    assert.ok(systemText.includes('"discovery"'), `${mode} template must document the field`);
    assert.ok(systemText.includes("RECORDING DISCOVERIES"), `${mode} template must carry the rules block`);
    assert.ok(
      systemText.includes("CONFIRMED DISCOVERIES"),
      `${mode} template must tell the model where the facts come back`,
    );
  }
});

test("REGRESSION: both templates tell the model discoveries can complete an answer", () => {
  // Without this the model holding four remembered numbers still will not
  // answer, because the old rule 3 told it to wait for ONE screenshot to show
  // everything - which for a comparison question never happens.
  for (const mode of ["pixel", "api"]) {
    const { systemText } = buildPrompt({ ...BASE, mode, discoveries: "" });
    assert.ok(
      /CONFIRMED DISCOVERIES plus the/.test(systemText),
      `${mode} template must amend the answer-early rule`,
    );
  }
});
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test test/prompt.test.js
```

Expected: FAIL — `buildPrompt` ignores `discoveries`, and the templates carry none of the new text.

- [ ] **Step 3: Update `SYSTEM_TEMPLATE`**

In `backend/src/vlmClient.js`, in `SYSTEM_TEMPLATE`, add a fourth bullet to the "On each turn you are shown" list:

```
- CONFIRMED DISCOVERIES: hard facts you recorded on earlier steps of this session
```

Change the shape line from:

```
{"thought": "<= 2 sentences explaining your reasoning", "action": { ... }}
```

to:

```
{"discovery": "<hard data visible in this screenshot, or null>", "thought": "<= 2 sentences explaining your reasoning", "action": { ... }}
```

Change rule 3 from:

```
3. Prefer "answer" as soon as the current screenshot shows everything needed - do not take extra actions once you already have enough information.
```

to:

```
3. Prefer "answer" as soon as CONFIRMED DISCOVERIES plus the current screenshot contain everything needed - do not take extra actions once you already have enough information.
```

And append this block after rule 7, at the very end of the template string:

```

RECORDING DISCOVERIES:
"discovery" records hard data visible in the CURRENT screenshot that you will need later.
- Numbers, names, labels, textual facts. Max 15 words.
- ALWAYS name what the value belongs to. Write "House avg beds = 3.3", never "avg beds = 3.3".
- Record NOTHING about the UI: not what is open or closed, not where a control is, not what you clicked.
- If this screenshot shows no new hard data, use null.
Discoveries persist for the WHOLE SESSION, including across follow-up questions, and are shown back to you every step under CONFIRMED DISCOVERIES. Never take an action to re-read a value that is already listed there.
```

- [ ] **Step 4: Update `PIXEL_SYSTEM_TEMPLATE` the same way**

Add the same fourth bullet to its "On each turn you are shown" list.

Change its shape line from:

```
{"thought": "<= 2 sentences", "action": { ... }}
```

to:

```
{"discovery": "<hard data visible in this screenshot, or null>", "thought": "<= 2 sentences", "action": { ... }}
```

Change its rule 3 from:

```
3. Prefer "answer" as soon as the screenshot shows everything needed.
```

to:

```
3. Prefer "answer" as soon as CONFIRMED DISCOVERIES plus the screenshot show everything needed.
```

And append the identical `RECORDING DISCOVERIES:` block after its rule 6, at the end of the template string.

Both templates get it: memory is orthogonal to grounding strategy, and giving it only to the pixel arm would confound the api-vs-pixel comparison the research half of the project owns.

- [ ] **Step 5: Thread `discoveries` through `buildPrompt`**

Replace `buildPrompt` (around line 148):

```js
function buildPrompt({ question, inventory, history, discoveries = "", correctiveFeedback, mode = "api" }) {
  const systemText = mode === "pixel" ? PIXEL_SYSTEM_TEMPLATE(question) : SYSTEM_TEMPLATE(question);
  const historyText = history.length ? history.map(formatHistoryLine).join("\n") : "(no actions taken yet)";
  const invText = formatInventoryForPrompt(inventory);

  let userText = `CURRENT INVENTORY:\n${invText}\n\nHISTORY:\n${historyText}\n`;
  // After HISTORY and before FEEDBACK: "what I did" then "what I learned"
  // read together, and the facts sit closest to the decision point. Omitted
  // entirely when empty - an empty labeled section costs tokens and invites
  // the model to fill it.
  if (discoveries) {
    userText += `\n${discoveries}\n`;
  }
  if (correctiveFeedback) {
    userText += `\nFEEDBACK ON YOUR LAST RESPONSE:\n${correctiveFeedback}\n`;
  }
  userText += `\nRespond with the JSON object now.`;

  return { systemText, userText };
}
```

- [ ] **Step 6: Pass it through `getNextAction`**

Change the signature (around line 480) to add `discoveries = ""`:

```js
export async function getNextAction({ config, question, inventory, history, discoveries = "", imagePath, correctiveFeedback, onAttempt = () => {}, stopSignal }) {
```

And the `buildPrompt` call inside the retry loop (around line 508):

```js
    const { systemText, userText } = buildPrompt({ question, inventory, history, discoveries, correctiveFeedback: feedback, mode: config.actuationMode ?? "pixel" });
```

- [ ] **Step 7: Run the tests**

```bash
npm test
```

Expected: PASS, including all six prompt tests.

- [ ] **Step 8: Commit**

```bash
git add backend/src/vlmClient.js backend/test/prompt.test.js
git commit -m "Show the model what it already knows, and let that be enough to answer

Adds the CONFIRMED DISCOVERIES block after HISTORY and the RECORDING
DISCOVERIES rules to both templates. Both arms get it - memory is orthogonal
to grounding strategy, and giving it only to pixel mode would confound the
api-vs-pixel comparison.

Rule 3 is amended in both: it used to say answer once THE SCREENSHOT shows
everything needed, which for a comparison question never happens. A model
holding four remembered numbers would have kept clicking.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Persist the discovery per step

**Files:**
- Modify: `backend/src/store.js:30-44` (CREATE TABLE), after line 121 (migration), `:168-173` (insertStep)

**Interfaces:**
- Consumes: nothing
- Produces: `steps.discovery` column; `insertStep` now **requires** a `discovery` key on its argument object (better-sqlite3 named parameters throw when a `@param` is missing, so every caller must pass it — Task 6 does)

- [ ] **Step 1: Add the column to the fresh-database schema**

In `backend/src/store.js`, in the `CREATE TABLE IF NOT EXISTS steps` block, add `discovery` immediately after `thought`:

```sql
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  step_idx INTEGER,
  thought TEXT,
  discovery TEXT,
  action_json TEXT,
  action_status TEXT,
  error_msg TEXT,
  frame_raw_path TEXT,
  overlay_json TEXT,
  inventory_json TEXT,
  settle_timeout INTEGER DEFAULT 0,
  started_at TEXT,
  duration_ms INTEGER
);
```

- [ ] **Step 2: Add the guarded migration for existing databases**

After the `turn_index` migration block (which ends at line 121), add:

```js
// Same guarded-ALTER idiom as error_message above: CREATE TABLE IF NOT EXISTS
// is a no-op on an existing table, so a pre-existing DB needs this to gain the
// column. On a fresh DB the CREATE above already made it and this throws
// "duplicate column", which is caught.
try {
  db.exec(`ALTER TABLE steps ADD COLUMN discovery TEXT`);
} catch (e) {
  if (!String(e.message).includes("duplicate column")) throw e;
}
```

- [ ] **Step 3: Write the column in `insertStep`**

Replace `insertStep` (lines 168–173):

```js
export function insertStep(step) {
  db.prepare(
    `INSERT INTO steps (session_id, step_idx, thought, discovery, action_json, action_status, error_msg, frame_raw_path, overlay_json, inventory_json, settle_timeout, started_at, duration_ms)
     VALUES (@session_id, @step_idx, @thought, @discovery, @action_json, @action_status, @error_msg, @frame_raw_path, @overlay_json, @inventory_json, @settle_timeout, @started_at, @duration_ms)`,
  ).run(step);
}
```

better-sqlite3 throws on a missing named parameter, so every caller must now pass `discovery` (null is fine). `orchestrator.js` is the only caller and Task 6 handles it.

- [ ] **Step 4: Verify the migration runs against the real database**

Run from `backend/`:

```bash
node -e "import('./src/store.js').then(()=>console.log('store loaded, migrations ran'))"
```

Expected: `store loaded, migrations ran` with no throw. Then confirm the column exists:

```bash
node -e "import('better-sqlite3').then(({default:D})=>{const d=new D('data/sessions.db');console.log(d.prepare('PRAGMA table_info(steps)').all().map(c=>c.name).join(', '))})"
```

Expected: the printed list includes `discovery`. If `data/sessions.db` is not the database path, read `backend/src/paths.js` for the real one and adjust.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store.js
git commit -m "Persist each step's discovery alongside its thought

Guarded ALTER plus the CREATE TABLE column, same idiom as error_message, so
fresh and pre-existing databases both land on the same schema. insertStep now
requires the key - better-sqlite3 throws on a missing named parameter, which
is the behavior we want here rather than a silently dropped column.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Record discoveries in the agent loop

**Files:**
- Modify: `backend/src/orchestrator.js`

**Interfaces:**
- Consumes: `createDiscoveryLog`, `stampFromInventory` (Task 2); `getNextAction`'s `discovery` return (Task 3); `discoveries` prompt arg (Task 4); `insertStep`'s `discovery` key (Task 5)
- Produces: `runSession({ …, discoveryLog })` — optional; defaults to a fresh per-run log so `run.js` and `eval.js` need no change. The `thought` event gains `discovery`. The `step` event gains `discovery`. A new warning kind `discovery_cap` is emitted at most once per session.

- [ ] **Step 1: Import the module**

In `backend/src/orchestrator.js`, add after the `pixelGuard` import (line 15):

```js
import { createDiscoveryLog, stampFromInventory } from "./discoveries.js";
```

- [ ] **Step 2: Accept an externally-owned log**

Add to the `runSession` destructured options, immediately after `turnIndex = null,`:

```js
  // Session-scoped hard-data memory. The conversation runtime passes its own
  // so facts survive across turns on one dashboard; standalone callers (CLI,
  // eval) get a fresh per-run log and need no change.
  discoveryLog: providedDiscoveryLog = null,
```

Then just after `const tracker = createInventoryTracker();` (line 142):

```js
  const discoveryLog = providedDiscoveryLog ?? createDiscoveryLog();
  // Emitted at most once per session - a cap warning per step would be noise.
  let discoveryCapWarned = false;
```

- [ ] **Step 3: Thread it into `forceBestEffortAnswer`**

Change the helper's signature and its `getNextAction` call (lines 55–66):

```js
async function forceBestEffortAnswer({ config, question, inventory, history, discoveries, framePath }) {
  const feedback =
    "You have reached the maximum number of steps. Based on everything you have seen so far, provide your " +
    'best-effort final answer NOW. You must respond with an "answer" action (or "fail" only if truly impossible).';
  const { valid, thought, action } = await getNextAction({
    config,
    question,
    inventory,
    history,
    discoveries,
    imagePath: framePath,
    correctiveFeedback: feedback,
  });
```

And its call site near the end of `runSession` (line 690):

```js
    const forced = await forceBestEffortAnswer({
      config,
      question,
      inventory: inv,
      history,
      discoveries: discoveryLog.format(),
      framePath: prevFramePath,
    });
```

This is the single most important call in the loop — the forced answer at budget exhaustion — and without this line it would be the one call that flies blind.

- [ ] **Step 4: Carry the step's discovery in loop-scoped state**

`persistAndEmit` is called from many branches. Rather than adding a parameter that some branch forgets to pass, hold it in loop state the way `prevFramePath` already is.

Declare it next to `discoveryCapWarned` in Step 2's block:

```js
  let stepDiscovery = null;
```

Reset it at the top of the `while` body, immediately after `idx++;`:

```js
    idx++;
    stepDiscovery = null;
```

Then inside `persistAndEmit`, add `discovery: stepDiscovery,` to the `store.insertStep({...})` call (right after `thought,`) and to the `onEvent({ type: "step", ... })` payload (right after `thought,`).

- [ ] **Step 5: Record the discovery and emit it with the thought**

In the main loop, replace the `getNextAction` destructure (line 282) to capture the new field:

```js
    const { valid, discovery, thought, action, rawText, errorKind, errorMessage } = await getNextAction({
      config,
      question,
      inventory: inv,
      history,
      discoveries: discoveryLog.format(),
      imagePath: framePath,
      correctiveFeedback,
      onAttempt: (attempt) => onEvent({ type: "vlm_attempt", idx, attempt }),
      stopSignal,
    });
```

Then, immediately after `invalidCount = 0;` (line 342) and before the `thought` event, add:

```js
    // Recorded BEFORE the action runs, and kept even if the action is then
    // rejected by the loop guard or the zoom-refine pass: a rejected click
    // does not invalidate the reading. The model looked at this frame and read
    // a number off it; whether its aim was any good is a separate question.
    // Rejected steps are common in pixel mode, so discarding their readings
    // would throw away a large share of what the agent learns.
    const recorded = discoveryLog.add({
      text: discovery,
      turnIndex,
      stepIdx: idx,
      stateStamp: stampFromInventory(inv),
    });
    // What is shown and stored is what actually entered memory, so the UI can
    // never imply the agent learned something it discarded as a duplicate.
    stepDiscovery = recorded.accepted ? recorded.text : null;
    if (recorded.evicted && !discoveryCapWarned) {
      discoveryCapWarned = true;
      onEvent({ type: "warning", idx, kind: "discovery_cap" });
    }
```

And extend the `thought` event on the next line:

```js
    onEvent({ type: "thought", idx, text: thought, discovery: stepDiscovery });
```

- [ ] **Step 6: Verify the loop still runs end to end**

Unit tests cannot cover the orchestrator loop (it needs Playwright and a live VLM), so verify with a real single-step run. From `backend/`, with `GEMINI_API_KEY` set in the repo-root `.env`:

```bash
npm run run-agent -- https://public.tableau.com/views/VideoGameSales-Dashboard/VideoGamePublishers "In the Top 5 Publishers chart, which publisher has the highest total sales?"
```

Expected: `ANSWER:` contains `Nintendo`, and the run completes without a `discovery` or `insertStep` error. This is the known-good 1-step reading demo from CLAUDE.md.

- [ ] **Step 7: Confirm the discovery actually reached the database**

```bash
node -e "import('./src/store.js').then(async s=>{const id=s.listSessions(1)[0].id;console.log(s.getSteps(id).map(x=>`#${x.step_idx} ${x.discovery ?? '(none)'}`).join('\n'))})"
```

Expected: at least one step prints a real fact rather than `(none)`. If every step is `(none)`, the model is not emitting the field — re-read Task 4 Step 3/4 and confirm the templates actually changed.

- [ ] **Step 8: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/orchestrator.js
git commit -m "Record what the model reads, and feed it back on every later step

The discovery is recorded before the action runs and kept even when that
action is then rejected by the loop guard or the refine pass - a rejected
click does not invalidate the reading, and rejected steps are common enough
in pixel mode that dropping their readings would lose a large share of what
the agent learns.

forceBestEffortAnswer gets the log too. It is the forced answer at budget
exhaustion, which is exactly the state the reported failure ends in, and it
would otherwise have been the one call with no memory at all.

The per-step value is held in loop state rather than passed as a parameter,
because persistAndEmit is called from many branches and one of them would
eventually forget to pass it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Make the memory span turns

**Files:**
- Modify: `backend/src/conversationRuntime.js` (around line 136 and line 773)
- Modify: `backend/src/server.js` (`startTurn`, `adaptAndPublish`, `buildSessionTrajectory`)

**Interfaces:**
- Consumes: `createDiscoveryLog` (Task 2), `runSession`'s `discoveryLog` option (Task 6)
- Produces: `runtime.discoveryLog`; the SSE `thought` event carries `discovery`; `buildSessionTrajectory` steps carry `discovery`

- [ ] **Step 1: Give the runtime a log**

In `backend/src/conversationRuntime.js`, add the import alongside the other `./` imports at the top:

```js
import { createDiscoveryLog } from "./discoveries.js";
```

Then in `createRuntime`, just before the `// --- Live-view state (Phase B1) ---` comment (around line 136):

```js
  // Session-scoped hard-data memory, shared by every turn on this dashboard.
  // Owned here rather than inside runSession so facts survive across turns -
  // a follow-up question starts with `const history = []` but keeps this.
  // Dropped with the runtime when the conversation closes, which IS the hard
  // delete: nothing writes the aggregate anywhere.
  const discoveryLog = createDiscoveryLog();
```

And add it to the returned runtime object (around line 773), after `dashboardName`:

```js
    discoveryLog,
```

- [ ] **Step 2: Pass it into each turn, and mark takeovers**

In `backend/src/server.js`'s `startTurn`, replace the `captureTakeoverEnd` line and the `runSession` call's opening options:

```js
  const takeover = await activeRuntime.captureTakeoverEnd();
  // captureTakeoverEnd returns null unless something actually changed (it
  // compares inventories AND the bridge event log), so a non-null result means
  // the human really did touch the dashboard. Mark rather than clear: they may
  // have only panned, and discarding correct facts is the worse error.
  if (takeover) {
    activeRuntime.discoveryLog.addNote(
      "— the user changed the dashboard here; readings above may predate that change —",
    );
  }

  runSession({
    browser: sharedBrowser,
    config,
    dashboardUrl: activeRuntime.dashboardUrl,
    dashboardName: activeRuntime.dashboardName,
    question,
    sessionId: turnId,
    page: activeRuntime.page,
    ownsPage: false,
    conversationId,
    turnIndex,
    discoveryLog: activeRuntime.discoveryLog,
```

Leave the rest of the call (`onEvent`, `shouldStop`, `stopSignal`) exactly as it is.

- [ ] **Step 3: Publish the discovery on the SSE thought event**

In `adaptAndPublish` (around line 230):

```js
    case "thought":
      bus.publish(sessionId, { type: "thought", idx: evt.idx, text: evt.text, discovery: evt.discovery ?? null });
      break;
```

- [ ] **Step 4: Include it in replayed trajectories**

In `buildSessionTrajectory` (around line 195), add to the mapped step object right after `thought: s.thought,`:

```js
    discovery: s.discovery ?? null,
```

- [ ] **Step 5: Verify the cross-turn path by hand**

Start the backend from `backend/`:

```bash
npm run dev
```

Then open the frontend preview and drive it. Ask on Video Game Sales:

1. *"In the Top 5 Publishers chart, which publisher has the highest total sales?"*
2. Then, in the **same** session: *"What was the publisher you just found?"*

Expected: the second turn answers **Nintendo** without clicking anything — it reads the fact out of `CONFIRMED DISCOVERIES`. If it re-navigates, the log is not being shared; re-check Step 2.

- [ ] **Step 6: Commit**

```bash
git add backend/src/conversationRuntime.js backend/src/server.js
git commit -m "Share one discovery log across every turn of a conversation

The log hangs off the runtime, not off runSession, so a follow-up question
keeps what the previous one learned even though it starts with an empty
history. It is dropped with the runtime when the conversation closes - that
is the hard delete, and it needs no cleanup code.

A takeover between turns appends a note rather than clearing the log. The
user may have only panned, and discarding correct facts is the worse error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Show discoveries in the Watch feed

**Files:**
- Modify: `frontend/src/screens/Watch/useSessionStream.js` (`mapStoredStepToStep`, `blankStep`, the `thought` case)
- Modify: `frontend/src/screens/Watch/Feed.jsx` (new `DiscoveryLine`, rendered in `StepCard` and `LiveStepCard`)
- Modify: `frontend/src/screens/Watch/warningLabels.js`

**Interfaces:**
- Consumes: the SSE `thought` event's `discovery` field and the trajectory step's `discovery` field (Task 7)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Carry the field through the replay mapper**

In `frontend/src/screens/Watch/useSessionStream.js`, in `mapStoredStepToStep` (around line 32), add after `thought: s.thought,`:

```js
    discovery: s.discovery ?? null,
```

- [ ] **Step 2: Carry it through the blank step**

In `blankStep` (around line 82), add after `thought: null,`:

```js
    discovery: null,
```

Without this the field is absent on a live step until its thought arrives, and React would read `undefined` rather than `null`.

- [ ] **Step 3: Carry it through the live reducer**

In `reduceEvent`'s `thought` case (line 136):

```js
    case "thought":
      return { ...run, steps: upsertStep(run.steps, evt.idx, { thought: evt.text, discovery: evt.discovery ?? null }) };
```

- [ ] **Step 4: Add the renderer**

In `frontend/src/screens/Watch/Feed.jsx`, add immediately after `ThoughtDisclosure` (after line 93):

```jsx
// A fact the model recorded off this step's screenshot. Unlike the thought,
// this is NOT hidden behind a disclosure: it is data the agent will still be
// using ten steps from now, and the whole point of showing it is to make the
// accumulating memory visible while the run happens.
function DiscoveryLine({ text }) {
  if (!text) return null;
  return (
    <div className="mt-1 flex items-baseline gap-2 pl-3.5">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-gold-ink/70">Discovery</span>
      <span className="font-mono text-xs leading-relaxed text-fg/75">{text}</span>
    </div>
  );
}
```

- [ ] **Step 5: Render it in both step cards**

In `StepCard`, change the reveal block (around line 191):

```jsx
        <>
          <ThoughtDisclosure text={step.thought} active={revealMode === "typing"} />
          <DiscoveryLine text={step.discovery} />
          {step.planned && step.planned.label !== "Answer" && (revealMode === "action-pending" || revealMode === "resolved") && (
            <ActionLine step={step} pending={revealMode === "action-pending"} />
          )}
        </>
```

In `LiveStepCard`, change the equivalent block (around line 239):

```jsx
        <>
          <ThoughtDisclosure text={step.thought} active={!step.planned} />
          <DiscoveryLine text={step.discovery} />
          {step.planned && step.planned.label !== "Answer" && <ActionLine step={step} pending={step.actionStatus == null} />}
        </>
```

- [ ] **Step 6: Label the new warning kind**

`Watch.jsx` renders `WARNING_LABEL[kind] ?? kind`, so an unlabeled kind shows the raw string `discovery_cap`. Add to the `WARNING_LABEL` object in `frontend/src/screens/Watch/warningLabels.js`:

```js
  discovery_cap: "The agent has recorded a lot of facts this session — the oldest are being dropped from its memory.",
```

- [ ] **Step 7: Verify in the browser**

Start the frontend preview (`preview_start({name: "frontend"})` or `npm run dev` from `frontend/`) with the backend already running. Ask the 2-step pixel-click demo from CLAUDE.md on Video Game Sales:

> Click the 'Electronic Arts' bar in the Top 5 Publishers chart to filter to that publisher, then report which single game has the highest global sales in the Top 10 Games chart

Expected: a `DISCOVERY` line appears under at least one step's Thought row, in mono type. Check `read_console_messages` for React errors and `read_network_requests` for failed calls. Then reload the finished session from History and confirm the same line renders from the replay path.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/screens/Watch/useSessionStream.js frontend/src/screens/Watch/Feed.jsx frontend/src/screens/Watch/warningLabels.js
git commit -m "Show each step's discovery under its thought

Deliberately not inside ThoughtDisclosure: the thought is reasoning you
expand when curious, the discovery is data the agent is still using ten steps
later, so it stays visible. Live and replay paths both carry it, so a
recorded session replays identically.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Make the eval matcher able to score comparative answers

**Files:**
- Create: `backend/src/evalMatch.js`
- Create: `backend/test/evalMatch.test.js`
- Modify: `backend/eval.js:50-65` (remove the local `matchesExpect`, import instead)

**Interfaces:**
- Consumes: nothing
- Produces: `matchesExpect(answer, question) → true | false | null` — `null` means "not scored", deliberately distinct from `false`. Requirement forms: string (substring), array (any-of substring), `{word}`, `{not}`, `{first}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/evalMatch.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { matchesExpect } from "../src/evalMatch.js";

const q = (expect, scored = true) => ({ expect, scored });

test("an unscored question returns null, never false", () => {
  assert.equal(matchesExpect("anything", q(["x"], false)), null);
  assert.equal(matchesExpect("anything", { expect: [] }), null);
});

test("a missing answer fails a scored question", () => {
  assert.equal(matchesExpect("", q(["nintendo"])), false);
  assert.equal(matchesExpect(null, q(["nintendo"])), false);
});

test("REGRESSION: existing substring and any-of forms are unchanged", () => {
  // eval/questions.json depends on these exactly as they are.
  assert.equal(matchesExpect("The answer is Nintendo.", q(["nintendo"])), true);
  assert.equal(matchesExpect("JFK had the most.", q([["kennedy", "jfk"]])), true);
  assert.equal(matchesExpect("Documentaries, 299 titles.", q(["documentaries", "299"])), true);
  assert.equal(matchesExpect("Documentaries only.", q(["documentaries", "299"])), false);
});

test("REGRESSION: bare substring matching cannot score a yes/no answer", () => {
  // This is why {word} exists: "notably" contains "no".
  assert.equal(matchesExpect("Yes, houses are notably higher.", q(["no"])), true);
  assert.equal(matchesExpect("Yes, houses are notably higher.", q([{ word: "no" }])), false);
  assert.equal(matchesExpect("No, houses are lower.", q([{ word: "no" }])), true);
});

test("{word} accepts an array as any-of", () => {
  assert.equal(matchesExpect("Houses are lower.", q([{ word: ["no", "lower"] }])), true);
});

test("{not} inverts any other form", () => {
  assert.equal(matchesExpect("NSW and QLD.", q([{ not: { word: "tas" } }])), true);
  assert.equal(matchesExpect("NSW, QLD and TAS.", q([{ not: { word: "tas" } }])), false);
  assert.equal(matchesExpect("NSW and QLD.", q([{ not: "tas" }])), true);
});

test("REGRESSION: {first} separates comparatives that share every substring", () => {
  // "Natural gas grew faster than nuclear" and its inverse contain identical
  // substrings; only the order distinguishes them.
  const req = q([{ first: ["natural gas", "nuclear"] }]);
  assert.equal(matchesExpect("Natural gas grew faster than nuclear.", req), true);
  assert.equal(matchesExpect("Nuclear grew faster than natural gas.", req), false);
});

test("{first} passes when the loser is absent, fails when the winner is", () => {
  const req = q([{ first: ["natural gas", "nuclear"] }]);
  assert.equal(matchesExpect("Natural gas.", req), true);
  assert.equal(matchesExpect("Nuclear.", req), false);
});

test("{first} matches on word boundaries, not substrings", () => {
  // "gas" must not match inside "gasoline".
  assert.equal(matchesExpect("Gasoline then gas.", q([{ first: ["gas", "gasoline"] }])), false);
});

test("regex metacharacters in a requirement are matched literally", () => {
  assert.equal(matchesExpect("the value is 11.31", q([{ word: "11.31" }])), true);
  assert.equal(matchesExpect("the value is 11x31", q([{ word: "11.31" }])), false);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test test/evalMatch.test.js
```

Expected: FAIL — `Cannot find module '../src/evalMatch.js'`.

- [ ] **Step 3: Write the module**

Create `backend/src/evalMatch.js`:

```js
// Answer scoring for the eval harness. Extracted out of eval.js so it can be
// unit-tested - eval.js runs main() on import and cannot be imported by a test.
//
// An `expect` entry is a list of requirements, ALL of which must hold:
//
//   "nintendo"                substring, case-insensitive
//   ["kennedy", "jfk"]        any-of, substring
//   {"word": "no"}            word-boundary match; array = any-of
//   {"not": <any form>}       must NOT hold
//   {"first": ["a", "b"]}     a's first word-boundary occurrence precedes b's;
//                             b absent = pass, a absent = fail
//
// The last two exist for comparative questions, which the multi-hop memory set
// is full of: "Natural gas grew faster than nuclear" and "Nuclear grew faster
// than natural gas" contain identical substrings, so substring matching scores
// both the same and a green result would mean nothing.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordIndex(hay, needle) {
  const m = new RegExp(`\\b${escapeRegex(needle)}\\b`, "i").exec(hay);
  return m ? m.index : -1;
}

function requirementHolds(hay, req) {
  if (Array.isArray(req)) return req.some((alt) => hay.includes(String(alt).toLowerCase()));
  if (req && typeof req === "object") {
    if ("not" in req) return !requirementHolds(hay, req.not);
    if ("word" in req) {
      const alts = Array.isArray(req.word) ? req.word : [req.word];
      return alts.some((alt) => wordIndex(hay, alt) !== -1);
    }
    if ("first" in req) {
      const [a, b] = req.first;
      const ia = wordIndex(hay, a);
      if (ia === -1) return false;
      const ib = wordIndex(hay, b);
      return ib === -1 || ia < ib;
    }
    return false;
  }
  return hay.includes(String(req).toLowerCase());
}

// Returns null when the question is not scored - deliberately distinct from
// false. Two questions in the shipped set have no establishable ground truth
// and must not be counted either way.
export function matchesExpect(answer, q) {
  if (q.scored === false || !q.expect || !q.expect.length) return null;
  const hay = String(answer ?? "").toLowerCase();
  if (!hay) return false;
  return q.expect.every((req) => requirementHolds(hay, req));
}
```

- [ ] **Step 4: Run the tests**

```bash
node --test test/evalMatch.test.js
```

Expected: PASS.

- [ ] **Step 5: Use it from `eval.js`**

In `backend/eval.js`, delete the local `matchesExpect` function and its comment block (lines 50–65) and add to the imports:

```js
import { matchesExpect } from "./src/evalMatch.js";
```

Nothing else changes — the call site on line 107 is already `matchesExpect(result.finalAnswer, q)`.

- [ ] **Step 6: Verify `eval.js` still parses and the existing set still scores identically**

```bash
node --check eval.js
```

Expected: no output (success).

Then confirm the extraction changed no verdicts, using the CSV from Task 1 rather than a fresh VLM run:

```bash
node -e "const fs=require('fs');const rows=fs.readFileSync('eval/results.csv','utf8').split('\n');console.log(rows.length-1,'rows;',rows.filter(r=>r.includes(',pass,')).length,'pass')"
```

Expected: the same pass count as the Task 1 baseline run. If `eval/results.csv` has since been overwritten by the memory-set run, use `eval/results-baseline-memory.csv` — that one is the memory set, so instead re-run `npm run eval -- eval/questions.json` and compare to the Task 1 number.

- [ ] **Step 7: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/evalMatch.js backend/test/evalMatch.test.js backend/eval.js
git commit -m "Give the eval matcher word boundaries, negation and ordering

Substring matching cannot honestly score the multi-hop set. expect [\"no\"]
passes on \"Yes, houses are notably higher\", and expect [\"nsw\",\"qld\"]
passes on the wrong answer \"NSW, QLD, and TAS\". Comparatives are worse:
\"Natural gas grew faster than nuclear\" and its inverse share every
substring, so only ordering separates them.

Extracted from eval.js because eval.js runs main() on import and could never
be unit-tested. Existing string and any-of forms are untouched and covered by
a regression test, so eval/questions.json scores exactly as before.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Score the feature and close the loop

This is the gate the frozen-core changes were made against. It is a measurement task with a checkpoint in the middle — **stop and show the user the answers at Step 2 before writing expect values.**

**Files:**
- Modify: `backend/eval/memory-questions.json` (expect values, `scored: true`)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above
- Produces: a scored memory eval set and updated project documentation

- [ ] **Step 1: Run the memory set**

From `backend/`:

```bash
npm run eval -- eval/memory-questions.json
```

Expected: 4 questions, 0 crashes, all reported `-` (still `scored: false`).

- [ ] **Step 2: CHECKPOINT — show the user the answers**

Print the four answers side by side with the dataset's ground truth:

```bash
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('eval/memory-questions.json','utf8'));const rows=fs.readFileSync('eval/results.csv','utf8').split('\n').slice(1);rows.filter(Boolean).forEach((r,i)=>{const q=j.questions[i];console.log('\n'+q.id);console.log('  want:',q.expected_answer);console.log('  got :',r)})"
```

Show this to the user and agree which questions the agent actually got right before writing any `expect`. Do not infer correctness alone — question 4 ("which fluctuates more") is a judgment call, and CLAUDE.md warns that dense fine-grained charts are hard to verify even by manual human inspection.

- [ ] **Step 3: Write the expect values**

Edit `backend/eval/memory-questions.json`. For each question the user agreed is scorable, set `scored: true` and write an `expect` list using the primitives from Task 9 that separates the observed-correct phrasing from a plausible wrong one. Starting points to adapt to the real phrasing:

```json
"expect": [{ "first": ["no", "yes"] }]
```
```json
"expect": [{ "first": ["natural gas", "nuclear"] }]
```
```json
"expect": [{ "word": "nsw" }, { "word": "qld" }, { "not": { "word": "tas" } }]
```
```json
"expect": [{ "first": ["office", "retail"] }]
```

Leave any question the user judged unscorable at `scored: false` and add a one-line `note` on that entry saying why — an unverifiable green tick is worse than no tick.

- [ ] **Step 4: Feature gate**

```bash
npm run eval -- eval/memory-questions.json
```

Expected: `Accuracy: n/m scored correct` with **n ≥ 2**. If it is below 2, do not paper over it — report the number and which questions failed, with the answers, so the user can decide whether the shortfall is memory or model capability.

- [ ] **Step 5: Regression gate**

```bash
npm run eval -- eval/questions.json
```

Expected: accuracy **at or above** the baseline recorded in Task 1 Step 1. If it dropped, the frozen-core changes regressed something. Report which questions changed verdict rather than adjusting the expects to match.

- [ ] **Step 6: Manual cross-turn check**

The eval harness is single-turn, so this is the only check that exercises the cross-turn requirement. With both processes running, open the Berlin dashboard:

```
https://public.tableau.com/views/AirBnBinEastvs_WestBerlin/AirBnBBerlin
```

Ask the beds comparison question, wait for it to finish, then ask a follow-up that reuses one of the recorded numbers, e.g. *"What was the average number of beds for Apartments?"*

Expected: the second turn answers from memory without re-selecting Apartment in the Property Type filter, and its steps show the earlier facts. Confirm the `DISCOVERY` lines accumulated across both turns in the feed.

- [ ] **Step 7: Update `CLAUDE.md`**

Three edits:

1. In the backend module map table, add after the `pixelGuard.js` row:

```markdown
| `discoveries.js` | Session-scoped hard-data memory: the model's per-step `discovery` string, normalized, deduped on the STAMPED form, capped at 40, and rendered back into every prompt as `CONFIRMED DISCOVERIES`. `stampFromInventory` derives the filter state a reading was taken under. Pure; owned by `conversationRuntime` so it spans turns and dies with the conversation. |
```

2. In the **Frozen vs. mutable** section, add to the frozen list a note that `actionSchema.js`'s `discovery` field must stay optional, and why:

```markdown
`StepResponseSchema.discovery` is optional **and** nullable on purpose: making it
required turns a cosmetic omission into an `invalid_json` step, and three of those
in a row end the run.
```

3. In **Non-obvious gotchas**, add two entries:

```markdown
- **The prompt carries all prior ACTIONS but only the current frame.** `history` is
  never truncated, but no earlier screenshot, thought, or raw response is ever
  re-sent. That is why `discoveries.js` exists — before it, a question needing two
  readings could not be answered, because nothing carried a number from one
  screenshot to the next.
- **`eval.js` and `run.js` normalize the dashboard URL themselves.** `server.js` is
  not the only place that needs `normalizeTableauViewUrl` — a browse-form URL in a
  question file burns the 90s open timeout and fails with no visible cause, because
  both URL forms return HTTP 200.
```

- [ ] **Step 8: Commit**

```bash
git add backend/eval/memory-questions.json CLAUDE.md
git commit -m "Score the memory eval set and document the module

Memory set: <n>/<m>. Regression set: <n>/<m> against a <baseline> baseline.

Expect values were written from observed answer text rather than guessed up
front - a substring matcher written blind cannot separate a right comparative
from a wrong one, and would have produced a green tick that meant nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Fill in the real numbers.

---

## Notes for the implementer

**On the frozen core.** Tasks 3, 4 and 6 touch modules that fail silently. If `npm test` passes after them, that proves nothing about answer quality — only Task 10's eval comparison does. Do not treat a green test suite as permission to skip Task 10.

**On the checkpoint in Task 10 Step 2.** That stop is deliberate. Writing `expect` values before seeing real output produces a matcher that scores its own assumptions.

**If a dashboard in the memory set will not open,** say so and stop rather than dropping the question quietly. These are third-party workbooks and any of them can be republished or withdrawn; a set that silently shrinks from four questions to three still prints a green accuracy.

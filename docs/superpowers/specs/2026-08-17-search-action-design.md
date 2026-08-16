# The `search` Action

**Date:** 2026-08-17
**Status:** Approved, not yet implemented
**Precedent:** `2026-08-10-scroll-action-design.md` (same pixel-mode action surface)

Named `search`, not `type`. The union discriminates on `"type"`, so a type action
would serialise as `{"type":"type","text":"..."}` — legal but unreadable in logs
and prompts. `search` also states what it does: it runs a filter-list search, not
free text entry into arbitrary fields.

## Problem

A Tableau filter dropdown for a high-cardinality field is unreachable by
scrolling. On the Netflix dashboard the Title filter's list is **6172 domain
values**, rendered as **4241 rows** (the Type filter is set to `Movie`, so only
movie titles are listed) spanning **101784px** of overflow. At the configured
300px scroll notch that is **~339 `scroll` steps** against a 15-step budget:
scrolling this list is not slow, it is arithmetically impossible.

The dropdown also occludes the dashboard while open. Measured: the open Title
list occupies x 13–453, y 132–854 of a 1720×1060 viz, covering the map and the
`Duration` KPI — which is exactly the field a question about a title needs.
`CLAUDE.md` already records the consequence: on sessions `17c9e689`, `bafdd4a7`
and `a92e4ea5` the agent asserted a duration for *American Horror Story* it had
never seen, and got it wrong (said 9, dashboard says 8).

Every step spent scrolling is a step spent with that occlusion in place. A search
collapses the hunt to one step and closes the dropdown one step later.

## Non-goals

- **Typing into arbitrary text inputs.** No configured dashboard has a parameter
  text field that has been measured. This action targets filter-list search boxes.
- **A second Enter to commit a selection.** The action narrows the list; picking a
  value stays a normal `click`, so one action keeps one observable effect.
- **A "search until found" looping action**, for the reason the scroll spec
  rejected "scroll until visible": it would hide N VLM calls inside one step.
- **Opening the dropdown.** That is an existing `click`. `search` requires it
  already open and fails cleanly if it is not.
- **Coordinates.** The box is auto-focused; aiming at it is unnecessary and
  measurably dangerous (finding 8).

## Findings from the probe

All measured 2026-08-17 against
`https://public.tableau.com/views/NetflixMoviesandTVShowsDashboard_17065467710800/Netflix`
through the real `host.html`, viewport 1920×1200, viz element 1720×1060, driven
with the same `page.mouse` / `page.keyboard` path the actuator uses.

**1. The search box exists and is reachable.** It is a
`<textarea class="QueryBox">` with `aria-label="Search (Enter)"`, at frame rect
`{x:14, y:133, w:438, h:17}` — normalized centre **(0.135, 0.133)**, height
**1.6% of the frame**. It does not exist in the DOM until the dropdown is opened.

**2. It is already focused the instant the dropdown opens.** Every run reported
`focused: true` and `document.activeElement.className === "QueryBox"` immediately
after the opening click, with no second click. This is what makes a
coordinate-free action possible.

**3. `page.keyboard.type` reaches it through the cross-origin iframe.** The
textarea's value went `""` → `"American"` → `"American Horror"` with no click at
all. CDP keyboard input crosses the frame boundary for the same reason mouse
input does.

**4. Typing alone does NOTHING.** After typing `American`, polled for 15s: 4241
rendered rows unchanged, first *visually* top row still `1 Chance 2 Dance`, the
scroll container's `scrollTop` still 0, `scrollHeight` still 101784. It neither
filters nor type-ahead-scrolls. Confirmed against a screenshot, not just the DOM.

**5. Enter is required, and it works.** With Enter the list collapses from 6172
values to **25 matching rows** — `American Anarchist` … `Wet Hot American
Summer` — all visible at once with no scrolling. `aria-label="Search (Enter)"` is
literal.

**6. Enter is NOT reliably intercepted.** Same code, two outcomes: in one run the
textarea's value became `"American\n"` and nothing filtered (the newline was
inserted, i.e. the widget's key handler did not preventDefault); in another the
value stayed `"American"` and the search ran. The design must detect this rather
than assume the keystroke worked.

**7. The pixel diff separates the two cases, but not the way `click`/`scroll`
assume.** `computeChangedRegions`:

| transition | regions | note |
|---|---|---|
| open → typed (8 chars, no Enter) | **1** | one 86×53 cell — the grid's minimum unit, the text echo |
| typed → typed (7 more chars) | **0** | seven characters produced no detectable change |
| typed → searched (Enter ran) | **3** | 344×212, 172×212, 258×265 — the list body redrawing |

So `regions.length === 0` cannot be the failure test as it is for `click` and
`scroll`: a *failed* search still echoes its text and scores 1.

**8. A near-miss click is destructive.** Clicking 2% of frame height below the
box's centre — onto the first list row — **selected the title `American
Anarchist`** and closed the dropdown, silently filtering the dashboard to a value
the model never read. The box is 1.6% of frame height, thinner than the ~2.6%
dropdown row that `refineClickPoint`'s window was sized for, so that miss is
likely rather than exotic. This is the wrong-answer class, not the wasted-step
class, and it is why `search` carries no coordinates.

**9. Opening the dropdown by synthetic coordinate click is flaky.** Across runs
it opened on click #1, #2 and #3, and in one run not within 4 clicks. Independent
of this action (it is an existing `click`), but it means integration testing will
see intermittent extra steps, and a `search` rejected for "nothing focused" may
be a symptom of that rather than a model error.

**10. Tableau's DOM is not a witness for the list, again.** After a successful
search, `[role='listbox']` goes `null` and a naive item count reads **0** while
25 rows are plainly rendered on screen. An early draft of this spec concluded
"Enter does nothing" from exactly that reading. Same lesson as `scrollTop` in the
scroll spec: measure the pixels, confirm against a screenshot.

**11. Context: api mode does not need this at all.** `getInventory` reports
`F6 field="Title" type=categorical operable=true` with a 6172-value domain, and
`applyCategoricalFilter("Title", ["American Anarchist"])` returns `{ok: true}`.
Pixel mode has no such route — the value must be reached through the UI — so
this action is a pixel-mode gap-closer, and any eval question built on it is
**not** cross-arm comparable.

**Scope caveat.** Every measurement above is one dashboard and one filter. The
auto-focus behaviour (finding 2) in particular is the load-bearing assumption,
and it is unverified elsewhere.

## Design

### Action shape

```json
{"type":"search","text":"American Horror Story","target":"the Title filter search box"}
```

```js
const SearchAction = z.object({
  type: z.literal("search"),
  text: z.string().min(1).max(100),
  target: z.string().optional(),
});
```

No `nx`/`ny`. Three things the scroll action needed therefore drop out entirely:
the aiming pass (`locate`/`refine`), the `rescalePair` extension plus its
`getNextAction` call-site guard, and all dead-point geometry. A `search` step
costs **one** VLM request where a pixel `click` costs two or three.

`target` is descriptive only — it labels the step in the trajectory and is never
resolved against anything.

### Actuator

A new `actuator.js` branch that touches no mouse at all:

1. **Focus check, before any keystroke.** Find the Tableau frame and read whether
   the focused element is a text entry. If not, return
   `{ok: false, error: "No text box is focused — open the filter dropdown first;
   its search box is focused automatically."}` and dispatch nothing.
2. `Control+A`, then `page.keyboard.type(text)`. The select-all makes a second
   search in an already-open dropdown replace the prior term rather than append
   (`"American"` + `"Horror"` → `"AmericanHorror"`); it is a no-op on an empty box.
3. `page.keyboard.press("Enter")`.

The focus check is what replaces the click, and it is why finding 8's failure
cannot occur: there is no coordinate to miss with.

Because no `mouse.move` happens, there is **no hover-highlight artifact** — so
unlike `scroll` this needs no `beforeWheel` pre-capture hook, and its guard can
baseline against the step's own pre-action frame.

`describeAction` returns `Search: "American Horror Story"`.

### Settle

`waitForSettle(page, config.settleGate)` with **no** `expectBridgeEvent`. The
search re-renders the list locally and applies no filter, so no
`filterchanged` / `parameterchanged` / `tabswitched` can fire, and demanding one
would burn the full `eventGraceMs` (4500ms) on every search. Same branch `scroll`
takes.

**Measured, not just reasoned.** Task 1's calibration script ran the open →
type → Enter sequence six times against the same Title filter and read
`waitForSettle`'s `sawBridgeEvent` after each: **`false` on all 6 runs**,
including the runs where the search actually ran (Enter intercepted, list
narrowed). No `filterchanged` / `parameterchanged` / `tabswitched` fires for a
search in either outcome, confirming `expectBridgeEvent` must stay unset here.

### Did the search run?

Two witnesses, because finding 7 rules out the simple one:

- **Primary, exact.** After Enter, read the focused element's value. A trailing
  newline means Enter was not intercepted and the search did not run — finding 6's
  exact signature.
- **Secondary, general.** The pixel diff against the step's own pre-action frame,
  requiring **≥2 changed regions**. Catches failures that are not the newline case.

**The ≥2 threshold is calibrated on six runs, all six against the same Title
filter (2026-08-17).** Enter was intercepted (search ran, `newline: false`) on
2 of 6; the widget swallowed it (search did not run, `newline: true`) on the
other 4 — finding 6's flakiness reproduces more often than not run-to-run. The
two groups separate cleanly: the 2 runs where the search ran scored **3
regions** each (areas `[72928, 36464, 68370]`, identical both times); the 4
runs where it did not scored **0 regions** each. `searchMinRegions: 2` sits in
the middle of that 0-vs-3 gap with no overlap observed. The failure side was
exercised (unlike a run that never separates), so this is a real two-sided
calibration, not a one-sided guess — though still one filter on one dashboard;
see the Scope caveat above.

A failed search persists as **`ok_nochange`** — the gold `!` in the feed, not a
green tick — with corrective feedback saying the search did not run and to click
the value directly instead.

### Loop guard

`actionKey` gains `search:${text.toLowerCase()}`.

Unlike `click` and `scroll`, `search` is **not** exempt from the exact-repeat
`dup` check. Repeating a scroll is how you travel further down a pane; repeating
an identical search is a genuine no-op, so it is rejected like a repeated
`set_filter`.

A successful search calls `clearStaleGuards`: dead click and scroll points judged
against a 4241-row list are stale once the list is 25 rows.

### Mode gate

Pixel-only, exactly like `click` and `scroll`. `getNextAction`'s
`isPixelOnlyAction` check extends to `search`, as does the belt-and-suspenders
branch in the orchestrator. The api-mode template is untouched, so the comparison
arm stays clean.

### Prompt

`PIXEL_SYSTEM_TEMPLATE` only. Added to the action list:

```
- {"type":"search","text":"American Horror Story","target":"the Title filter search box"}
```

And a rule, placed beside the existing scroll rules 7 and 8:

> Some dropdown lists hold thousands of values and CANNOT be reached by
> scrolling. If you have opened a list and the value you want is not visible,
> use "search" instead of scrolling: it filters the list to matching entries in
> one step. The list must already be open — its search box is focused
> automatically when it opens, so you do not click the box first. After
> searching, read the narrowed list on the next screenshot and click the row.

### Live view

No coordinates, so no `Stage.jsx` overlay ring — the action has no point to draw.
`Feed.jsx` gains a `search` case in its `ok_nochange` explanation alongside the
existing click and scroll ones ("the search did not run — the list was not
filtered").

## Files touched

**Frozen core** — needs the eval comparison, not just unit tests:

- `backend/src/actionSchema.js` — `SearchAction` variant
- `backend/src/vlmClient.js` — pixel template, mode gate
- `backend/src/orchestrator.js` — `search` branch, `actionKey`, guard clearing

**Normal edit surface:**

- `backend/src/actuator.js` — `search` case, focus check, `describeAction`
- `frontend/src/screens/Watch/Feed.jsx` — `ok_nochange` explanation
- `backend/eval/questions.json` — a scored Netflix question that is currently
  unanswerable
- `CLAUDE.md` — action count 9 → 10, and the gotchas from findings 4, 6 and 10

## Testing

Unit (`npm test`):

- `actionSchema.test.js` — a valid search parses; empty `text` fails; text over
  100 chars fails; `nx`/`ny` are not accepted.
- `prompt.test.js` — `search` appears in the pixel template and is absent from the
  api one.
- The actuator's focus-check rejection path, against a fake page — no keystrokes
  dispatched when nothing is focused.
- The orchestrator's `dup` rejection on an identical search string, and the
  case-insensitivity of the key.

Integration, by hand against the running app:

- Netflix → *"What is the duration of American Horror Story?"* — the documented
  occlusion case. Expect click (open) → search → click (row) → answer **8
  Seasons**. Note finding 9: the opening click may take more than one attempt.
- A `search` issued with no dropdown open — expect a clean rejection with no
  keystrokes dispatched, not a wasted settle cycle.

## Verification

Three frozen-core modules change and they fail silently, so:

1. `npm run eval -- eval/questions.json` **before**, recorded as the baseline.
2. Implement.
3. Re-run and compare.

Same honesty caveat as the scroll spec: adding an action and a rule changes the
prompt for **every** question, including those with nothing to search, so
unrelated results can move without anything being broken. Treat a change as
signal only if it reproduces on a second run. The new Netflix question is a
standalone pass/fail check, not part of the accuracy comparison.

Ground truth for the new question must be read off a fresh capture before it is
trusted — `CLAUDE.md` records that the real-world figure (9 seasons) and the
dashboard's figure (8) disagree, which is exactly the trap this question exists
to catch.

## Deferred

- **Verifying auto-focus on a second dashboard.** Finding 2 is the load-bearing
  assumption and rests on one filter. Spotify's Artists dropdown is the obvious
  second sample. If auto-focus does not hold there, the focus check degrades
  gracefully (a clean rejection) rather than misbehaving — but the action would
  be unusable on that dashboard.
- **Why the opening click is flaky** (finding 9). Independent of this action.
- **Search boxes outside filter dropdowns**, if a dashboard is found that has one.

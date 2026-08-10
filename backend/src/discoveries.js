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
// A range bound that says nothing. Tableau reports an unbounded quantitative
// filter as the STRING "Null", not as JS null, so a `== null` test misses it and
// a filter constraining nothing eats one of the three stamp slots. Observed on
// the World Government Summit dashboard as `Value=[Null..Null]`.
function meaninglessBound(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "null" || s === "undefined";
}

// How much a parameter's current value tells you about what is on screen.
//
// The old code took the first two parameters in inventory order, which is
// arbitrary: on the World Government Summit dashboard that picked `Rank` and
// `Bin Size` - two free numeric knobs used for internal calcs - and truncated
// away `country=Russia`, the one value every reading on that dashboard depends
// on. A parameter offering many alternatives is a CHOICE, and its current value
// is what qualifies a reading; a knob with no enumerated alternatives is not.
function parameterInformativeness(p) {
  return Array.isArray(p.allowable) ? p.allowable.length : 0;
}

export function stampFromInventory(inventory) {
  if (!inventory) return "";
  const parts = [];

  if (Array.isArray(inventory.sheets) && inventory.sheets.length > 1) {
    const active = inventory.sheets.find((s) => s.active);
    if (active?.name) parts.push(`sheet=${active.name}`);
  }

  // Ranked, not sliced blind. Stable within a score so inventory order still
  // breaks ties predictably.
  const rankedParams = (inventory.parameters ?? [])
    .map((p, i) => ({ p, i, score: parameterInformativeness(p) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.p);

  for (const p of rankedParams.slice(0, 2)) {
    if (p.current === undefined || p.current === null || p.current === "") continue;
    parts.push(`${p.name}=${p.current}`);
  }

  for (const f of inventory.filters ?? []) {
    if (f.type === "categorical") {
      if (!Array.isArray(f.applied) || f.applied.length === 0 || f.applied.length > 3) continue;
      if (Array.isArray(f.domain) && f.applied.length >= f.domain.length) continue;
      parts.push(`${f.field}=${f.applied.join("|")}`);
    } else if (f.type === "range") {
      if (meaninglessBound(f.appliedMin) && meaninglessBound(f.appliedMax)) continue;
      if (f.appliedMin === f.domainMin && f.appliedMax === f.domainMax) continue;
      parts.push(`${f.field}=[${f.appliedMin ?? "?"}..${f.appliedMax ?? "?"}]`);
    }
  }

  const kept = parts.slice(0, STAMP_MAX_ENTRIES).join(", ");
  return kept.length > STAMP_MAX_CHARS ? kept.slice(0, STAMP_MAX_CHARS - 1) + "…" : kept;
}

// Words that describe WHERE something is rather than WHAT it is. A target is
// phrased as "the 'Brazil' row in the country dropdown list", so matching on this
// vocabulary would discard nearly every reading taken on a rejected step.
const TARGET_STOPWORDS = new Set([
  "the", "a", "an", "in", "on", "of", "at", "to", "for", "and", "or", "with", "its", "that", "this",
  "row", "rows", "list", "lists", "dropdown", "dropdowns", "menu", "menus", "item", "items",
  "bar", "bars", "tab", "tabs", "button", "buttons", "chart", "charts", "pane", "panes",
  "filter", "filters", "option", "options", "cell", "cells", "column", "columns", "label", "labels",
  "open", "closed", "selector", "select", "box", "panel", "legend", "axis", "header", "title",
  "top", "left", "right", "bottom", "area", "region", "stack", "pie", "slice", "chart",
]);

// True when a discovery talks about the very element the aiming pass just PROVED
// is not on screen.
//
// The aiming pass is a real verdict: locate searched the whole frame for the
// named target and refine agreed it is absent. A "discovery" recorded on that
// same step that names the same thing therefore cannot be a reading - it is the
// model writing down what it expected to find once it got there.
//
// This is deliberately narrow. A reading about something ELSE on a rejected step
// is legitimate and must survive: rejections are common in pixel mode, and the
// current frame is still perfectly readable. Only the specific claim about the
// proven-absent element is dropped.
export function claimsAbsentTarget(discoveryText, target) {
  if (!discoveryText || !target) return false;
  const hay = String(discoveryText).toLowerCase();
  const tokens = String(target).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const distinctive = tokens.filter((t) => t.length >= 3 && !TARGET_STOPWORDS.has(t));
  if (distinctive.length === 0) return false;
  return distinctive.some((t) => new RegExp(`\\b${t}\\b`).test(hay));
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
    return { accepted: true, reason: null, evicted: evictToCap(), text: normalized, key };
  }

  // Removes an entry that should never have been trusted - currently only a claim
  // about an element the aiming pass proved absent (see claimsAbsentTarget).
  //
  // The discovery is added BEFORE the action runs, deliberately, so a reading
  // survives a rejected action. That is right for a value read off the frame and
  // wrong for a value the model merely anticipated, and which one it is only
  // becomes knowable after aiming. Hence retraction rather than reordering.
  //
  // Not a permanent ban: the key leaves the log entirely, so the same fact can be
  // recorded again once the agent actually reaches that state and sees it.
  function retract(key) {
    if (!key) return false;
    const i = entries.findIndex((e) => e.kind === "fact" && e.key === key);
    if (i === -1) return false;
    entries.splice(i, 1);
    return true;
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
    retract,
    format,
    entries: () => entries.map((e) => ({ ...e })),
    size: () => entries.length,
  };
}

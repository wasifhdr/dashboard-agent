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

// Past-tense, first-person action verbs. Present and future forms are absent on
// purpose: "I will search" and "I am searching" are plans, and a guard that
// fired on them would reject the step that is about to do the right thing.
const CLAIM_VERBS = [
  "searched", "clicked", "selected", "filtered", "typed", "applied",
  "switched", "scrolled", "opened", "chose", "picked", "entered", "set",
];

// Only bare "I <verb>" and a few completive adverbs count. Anything else
// between the pronoun and the verb ("will", "need to", "should", "am") is a
// modal, and modals are what separate a plan from a claim - so leaving them out
// of this group is the whole tense test.
const CLAIM_RE = new RegExp(
  `\\b(?:i|we)\\s+(?:have\\s+|had\\s+|already\\s+|just\\s+|then\\s+)*(${CLAIM_VERBS.join("|")})\\b`,
  "i",
);

const OBJECT_LEAD_RE = /^(?:for|on|onto|in|into|to|at|by|through)\s+/i;
const OBJECT_DET_RE = /^(?:the|a|an|its|his|her|their|my|our|that|this|these|those)\s+/i;
// Where the named thing stops and the rest of the sentence begins.
const OBJECT_END_RE =
  /\s+(?:and|then|in|to|so|which|but|because|from|on|at|for|with|while|after|before|as|now|it)\s+|[,.;:!?]/i;

// Crude singularization, applied to BOTH sides of the comparison so it only has
// to be self-consistent, not linguistically right. It exists because the model
// paraphrases its own actions - a recorded "TV Show" comes back as "TV Shows" -
// and a plural alone must never read as a different thing.
function singularize(token) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function distinctiveTokens(text) {
  const raw = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set();
  for (const t of raw) {
    if (t.length < 3) continue;
    const s = singularize(t);
    if (TARGET_STOPWORDS.has(s) || TARGET_STOPWORDS.has(t)) continue;
    out.add(s);
  }
  return out;
}

// True when the model says it DID something the orchestrator never executed.
//
// The failure this exists for: on session 07d5fcc0 (2026-08-19) the agent read
// "13 Reasons Why duration = 3 Seasons" honestly, then asserted "I searched for
// American Horror Story in the title filter and read its duration as 9 Seasons"
// and answered with confidence 1.0. It never ran that search; 9 is the
// real-world figure, and the dashboard says 8. Nothing downstream could catch
// it, because a fabricated discovery is indistinguishable AS TEXT from an
// honest one - both are model-authored strings that land in the log identically.
//
// What separates them is provenance. `history` is written by the orchestrator
// from what the actuator actually did, so the model cannot author its way into
// it: a claimed action with no trace there did not happen.
//
// Deliberately RELUCTANT, in three ways, because a false positive rejects a
// CORRECT answer - a worse outcome than missing a fabrication that the step
// budget or a later guard can still catch:
//   - only executed (status "ok") entries count as evidence, but a click that
//     ran and changed nothing still counts: the model did click there;
//   - evidence is pooled across every action type rather than matched to the
//     claimed verb, so "searched" backed by a click on the same thing passes;
//   - ANY overlapping distinctive token vouches for the claim. The guard fires
//     only when the run contains NO trace of the named thing at all.
//
// Its known limit is the mirror of that reluctance: it reads what the model
// SAYS it did, so a bare discovery with no narration gives it nothing to check.
// See the state-contradiction check for the complementary half.
//
// `action` is the step's OWN pending action, and it vouches for itself: the
// model writes "I clicked India" in the same breath as emitting the click on
// India roughly as often as it writes it truthfully about an earlier step. The
// tense is sloppy, the action is correct, and rejecting it would throw away a
// good step (measured: 3 of the 5 false positives in the 493-session replay).
//
// Returns {verb, object} for the unperformed claim, or null.
export function claimsUnperformedAction(text, history, action = null) {
  if (!text || !Array.isArray(history)) return null;

  const m = CLAIM_RE.exec(String(text));
  if (!m) return null;

  let rest = String(text).slice(m.index + m[0].length).trimStart();
  rest = rest.replace(OBJECT_LEAD_RE, "").replace(OBJECT_DET_RE, "");
  const end = rest.search(OBJECT_END_RE);
  const object = (end === -1 ? rest : rest.slice(0, end)).trim();

  const claimed = distinctiveTokens(object);
  // Nothing but positional vocabulary ("the row in the dropdown") names no
  // identity to look for, and guessing at one would reject a legitimate step.
  if (claimed.size === 0) return null;

  const evidence = new Set();
  for (const source of [...history.filter((h) => h?.status === "ok"), action]) {
    if (!source) continue;
    // `target` is optional in the schema and the model does omit it. A click
    // with no target could have hit anything, so a run containing one cannot
    // support "there is no trace of X" - the only claim this guard makes.
    // Abstaining is the honest verdict, not a hedge.
    if (source.type === "click" && !source.target) return null;
    // Direction is included because "I scrolled down" names no target at all,
    // so without it every truthful scroll claim reads as unperformed.
    const said = `${source.text ?? ""} ${source.target ?? ""} ${source.direction ?? ""}`;
    for (const t of distinctiveTokens(said)) evidence.add(t);
  }
  for (const t of claimed) if (evidence.has(t)) return null;

  return { verb: m[1].toLowerCase(), object };
}

// --- filter-state contradiction -------------------------------------------
//
// The complementary half of claimsUnperformedAction. That one asks whether the
// model DID what it says it did; this one asks whether the dashboard could have
// been SHOWING what it says it read - and needs no narration at all, so it
// still bites when the model volunteers nothing but a bare fact.
//
// The rule: a reading that names entity Y, taken while the filter that selects
// entities is pinned to a single value X != Y, is not a reading of that frame.
// Every input comes from the live bridge inventory, so the model cannot author
// its way around it.
//
// Measured over 493 recorded sessions. The rule in that bare form fires 31
// times and is WRONG 19 of them, for three structural reasons that each became
// one of the gates below. With all three it fires 13 times, all 13 genuine.

// Below this, a domain is a category set (Airbnb's five property types), not an
// entity picker. Ordinary English collides with small sets - five sessions
// tripped on the phrase "all other types" matching a literal domain value
// called "Other Types".
const ENTITY_DOMAIN_MIN = 50;

// How far after the named entity to look for a digit. A claim carrying no
// measurement is usually an honest description of what the OPEN DROPDOWN
// contains - it lists the whole domain, so naming unapplied values is expected.
const MEASUREMENT_WINDOW = 45;

// Values worth matching on. A one-word, short value ("House", "Home") is a word
// of English before it is an entity, and matching it invents contradictions.
function distinctiveValue(v) {
  const s = String(v ?? "").trim();
  return s.length >= 8 || s.split(/\s+/).length >= 2;
}

// Index of `needle` in the already-lowercased `hay` at word boundaries, or -1.
// Bounded because "American Horror" is a prefix of "American Horrorshow".
function indexOfWord(hay, needle) {
  if (!needle) return -1;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) return -1;
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    if (!(before && /[a-z0-9]/.test(before)) && !(after && /[a-z0-9]/.test(after))) return i;
    from = i + 1;
  }
}

// `agentSetValues` is what the agent itself actually operated: the target/text
// of every EXECUTED action this session. A filter the agent never touched was
// applied at load, and a load-time filter does not necessarily govern the chart
// the model read - Spotify opens pinned to one artist while the bubble chart
// still shows all of them. Requiring the agent to have set it is what makes
// "the dashboard cannot be showing Y" a claim about this run rather than a
// guess about the workbook.
//
// Returns {field, applied, named} for the contradiction, or null.
export function contradictsFilterState(text, inventory, agentSetValues) {
  if (!text || !inventory || !Array.isArray(agentSetValues)) return null;
  const hay = String(text).toLowerCase();
  const operated = agentSetValues.map((v) => String(v ?? "").toLowerCase());

  for (const f of inventory.filters ?? []) {
    if (f.type !== "categorical") continue;
    // Exactly one value: a filter showing several is not pinned to an entity,
    // and one showing none constrains nothing.
    if (!Array.isArray(f.applied) || f.applied.length !== 1) continue;
    if (!Array.isArray(f.domain) || f.domain.length < ENTITY_DOMAIN_MIN) continue;

    const applied = String(f.applied[0]);
    if (!distinctiveValue(applied)) continue;
    if (!operated.some((v) => v.includes(applied.toLowerCase()))) continue;
    // A text naming the applied value too is a COMPARISON ("13 Reasons Why is 3
    // Seasons and American Horror Story is 9"), which is ambiguous rather than
    // false - the first half may be a legitimate reading of this very frame.
    if (indexOfWord(hay, applied.toLowerCase()) !== -1) continue;

    for (const value of f.domain) {
      const named = String(value);
      if (named === applied || !distinctiveValue(named)) continue;
      const at = indexOfWord(hay, named.toLowerCase());
      if (at === -1) continue;
      if (!/\d/.test(hay.slice(at, at + named.length + MEASUREMENT_WINDOW))) continue;
      return { field: f.field, applied, named };
    }
  }
  return null;
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

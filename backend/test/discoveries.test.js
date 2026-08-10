import test from "node:test";
import assert from "node:assert/strict";

import {
  createDiscoveryLog,
  normalizeDiscoveryText,
  stampFromInventory,
  claimsAbsentTarget,
} from "../src/discoveries.js";

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

// Regression: the World Government Summit dashboard, 2026-08-10. Every reading
// in that session was stamped "Rank=1, Bin Size=1, Value=[Null..Null]" - three
// slots of pure noise - while `country=Russia`, the ONE piece of state the
// readings actually depended on, was truncated away. The model then recorded
// per-country figures for Brazil, China and India without ever leaving Russia,
// and the log had no way to show that all four claims shared one state.
const WGS_INV = {
  activeSheet: "DASHBOARD",
  sheets: [{ id: "S1", name: "DASHBOARD", active: true }],
  filters: [
    { id: "F2", field: "Value", type: "range", appliedMin: "Null", appliedMax: "Null", domainMin: "Null", domainMax: "Null" },
    { id: "F3", field: "view", type: "categorical", applied: ["False"], domain: ["False"] },
  ],
  parameters: [
    { id: "P1", name: "Rank", type: "all", current: "1", allowable: [] },
    { id: "P2", name: "Bin Size", type: "all", current: "1", allowable: [] },
    { id: "P3", name: "view param", type: "list", current: "True", allowable: ["True", "False"] },
    { id: "P4", name: "country", type: "list", current: "Russia", allowable: ["Afghanistan", "Albania", "Algeria", "Angola", "Argentina"] },
    { id: "P5", name: "Measure", type: "list", current: "GDP per Capita", allowable: ["GDP per Capita", "Population"] },
  ],
};

test("REGRESSION: the parameter a reading actually depends on is not crowded out by noise", () => {
  const stamp = stampFromInventory(WGS_INV);
  assert.ok(stamp.includes("country=Russia"), `country must be stamped, got: ${stamp}`);
});

test("a range filter whose applied bounds are not real numbers constrains nothing", () => {
  // Tableau reports these as the STRING "Null", so `appliedMin == null` misses
  // them and a meaningless filter eats a stamp slot.
  const inv = {
    ...EMPTY_INV,
    filters: [{ id: "F1", field: "Value", type: "range", appliedMin: "Null", appliedMax: "Null" }],
  };
  assert.equal(stampFromInventory(inv), "");
});

test("a list parameter with more alternatives outranks one with fewer", () => {
  // More alternatives means the current value specifies more about what is on
  // screen, so it is the better thing to spend a limited stamp slot on.
  const inv = {
    ...EMPTY_INV,
    parameters: [
      { id: "P1", name: "Toggle", type: "list", current: "True", allowable: ["True", "False"] },
      { id: "P2", name: "country", type: "list", current: "Russia", allowable: ["A", "B", "C", "D", "E", "F"] },
    ],
  };
  const stamp = stampFromInventory(inv);
  assert.ok(stamp.startsWith("country=Russia"), `expected country first, got: ${stamp}`);
});

test("a free numeric knob does not outrank a real choice", () => {
  const inv = {
    ...EMPTY_INV,
    parameters: [
      { id: "P1", name: "Bin Size", type: "all", current: "1", allowable: [] },
      { id: "P2", name: "country", type: "list", current: "Russia", allowable: ["A", "B", "C"] },
    ],
  };
  assert.ok(stampFromInventory(inv).startsWith("country=Russia"));
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

// --- claimsAbsentTarget ----------------------------------------------------
//
// The aiming pass can PROVE a named element is not on screen (locate searched
// the whole frame and refine agreed). A "discovery" recorded on that same step
// that talks about the very thing just proven absent cannot be a reading - it is
// the model writing down what it expected to find. That is exactly how three
// fabricated country readings entered the log on 2026-08-10.

test("a claim about the element just proven absent is caught", () => {
  assert.equal(
    claimsAbsentTarget("Brazil Unemployment Score = 11.2%, Brazil Extreme Poverty = 5.9%", "Brazil in the country dropdown list"),
    true,
  );
  assert.equal(
    claimsAbsentTarget("China Unemployment Score = 5.0%", "China in the country dropdown"),
    true,
  );
});

test("a reading about something else on the same step is kept", () => {
  // The aim failed, but this number was legitimately read off the visible frame.
  // Discarding it would throw away real work - rejected steps are common.
  assert.equal(
    claimsAbsentTarget("Russia Unemployment Score = 5.0%", "Brazil in the country dropdown list"),
    false,
  );
  assert.equal(
    claimsAbsentTarget("Total titles = 6,234", "the Type dropdown"),
    false,
  );
});

test("UI vocabulary alone never triggers it", () => {
  // "dropdown"/"list"/"chart" are how targets are phrased; matching on them
  // would discard almost every reading taken on a rejected step.
  assert.equal(claimsAbsentTarget("Open list shows 12 rows", "the country dropdown list"), false);
  assert.equal(claimsAbsentTarget("Top 5 chart has 5 bars", "the Publisher bar in the chart"), false);
});

test("it is case- and punctuation-insensitive", () => {
  assert.equal(claimsAbsentTarget("brazil extreme poverty = 5.9%", "Brazil in the country dropdown list"), true);
  assert.equal(claimsAbsentTarget("Ed Sheeran songs = 4", "the 'Ed Sheeran' row in the Artists list"), true);
});

test("missing or empty inputs are never a claim", () => {
  assert.equal(claimsAbsentTarget(null, "Brazil row"), false);
  assert.equal(claimsAbsentTarget("Brazil = 1", null), false);
  assert.equal(claimsAbsentTarget("", ""), false);
});

// --- retract ---------------------------------------------------------------

test("a retracted entry leaves the log and stops being formatted", () => {
  const log = createDiscoveryLog();
  const a = log.add({ text: "Russia Unemployment = 5.0%", stepIdx: 1 });
  const b = log.add({ text: "Brazil Unemployment = 11.2%", stepIdx: 2 });
  assert.equal(log.size(), 2);

  assert.equal(log.retract(b.key), true);
  assert.equal(log.size(), 1);
  assert.ok(log.format().includes("Russia"));
  assert.ok(!log.format().includes("Brazil"));

  // Retracting something already gone is a no-op, not an error.
  assert.equal(log.retract(b.key), false);
  assert.equal(log.retract(null), false);
  assert.equal(log.size(), 1);
  assert.ok(a.key);
});

test("a retracted fact can be recorded again later, once actually seen", () => {
  // Retraction must not poison the value forever - the agent may reach that
  // state for real on a later step.
  const log = createDiscoveryLog();
  const first = log.add({ text: "Brazil Unemployment = 11.2%", stepIdx: 2 });
  log.retract(first.key);
  const second = log.add({ text: "Brazil Unemployment = 11.2%", stepIdx: 5 });
  assert.equal(second.accepted, true);
  assert.equal(log.size(), 1);
});

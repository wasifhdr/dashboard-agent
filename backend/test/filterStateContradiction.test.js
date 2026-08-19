import test from "node:test";
import assert from "node:assert/strict";

import { contradictsFilterState } from "../src/discoveries.js";

// A domain big enough to read as an entity picker rather than a category set.
const padded = (...values) => [
  ...values,
  ...Array.from({ length: 60 }, (_, i) => `Filler Entry Number ${i}`),
];

const netflix = (applied) => ({
  filters: [
    {
      id: "F1",
      field: "Title",
      type: "categorical",
      applied: [applied],
      domain: padded("13 Reasons Why", "American Horror Story", "A Cinderella Story", "21 & Over"),
    },
  ],
});

const zillow = (applied) => ({
  filters: [
    {
      id: "F1",
      field: "RegionName",
      type: "categorical",
      applied: [applied],
      domain: padded("Aberdeen, WA", "Abilene, TX", "Boston, MA", "United States"),
    },
  ],
});

// Airbnb's Property Type: a small category set, not an entity picker. Note it
// really does contain a value called "Other Types".
const airbnb = (applied) => ({
  filters: [
    {
      id: "F1",
      field: "Property Type (group)",
      type: "categorical",
      applied: [applied],
      domain: ["Apartment", "House", "Hotel/Hostel", "Other Types", "All types"],
    },
  ],
});

// --- true positives, both from real sessions -------------------------------

test("REGRESSION (07d5fcc0 #8, 11f816e1 #7): a duration for a title that is not selected", () => {
  const hit = contradictsFilterState(
    "American Horror Story duration = 9 Seasons",
    netflix("13 Reasons Why"),
    ["the '13 Reasons Why' row in the Title dropdown"],
  );
  assert.ok(hit, "expected the contradiction to be reported");
  assert.equal(hit.field, "Title");
  assert.equal(hit.applied, "13 Reasons Why");
  assert.equal(hit.named, "American Horror Story");
});

test("REGRESSION (41151523 #4): a value banked one step BEFORE the filter was applied", () => {
  // The agent clicked Abilene at this step; the frame it was reading still
  // showed Aberdeen. Its own step-5 reading says $121,000, not $152,700.
  const hit = contradictsFilterState(
    "Abilene, TX median home value in 2020 is $152,700",
    zillow("Aberdeen, WA"),
    ["Select Region dropdown", "Aberdeen, WA row"],
  );
  assert.ok(hit);
  assert.equal(hit.named, "Abilene, TX");
});

// --- the three gates, each from the false positive that earned it ----------

test("GATE agent-set (d64da7f8 #1): a filter applied at LOAD does not govern the frame", () => {
  // Spotify opens pinned to one artist while the bubble chart still shows
  // every artist. The agent never touched the filter, so it proves nothing.
  const spotify = {
    filters: [
      { id: "F1", field: "Artists", type: "categorical", applied: ["Ed Sheeran"], domain: padded("Ed Sheeran", "Post Malone") },
    ],
  };
  assert.equal(contradictsFilterState("Post Malone has 3 songs", spotify, []), null);
});

test("GATE measurement (ad4da63d #7): describing what is IN the open dropdown", () => {
  // An open filter list displays the whole domain, so naming unapplied values
  // is an honest reading. Only a claim carrying a MEASUREMENT is checkable.
  assert.equal(
    contradictsFilterState(
      "Last titles in dropdown menu include A Cinderella Story: Christmas Wish",
      netflix("21 & Over"),
      ["21 & Over row in the Title dropdown"],
    ),
    null,
  );
});

test("GATE domain size (147bdf5c #7): ordinary English collides with small category sets", () => {
  // "not higher than all other types" matches the literal domain value
  // "Other Types". A 5-value category set is not an entity picker.
  assert.equal(
    contradictsFilterState(
      "No, the average beds for Houses is not higher than that of all other types (Hotel/Hostel 4.3 in East).",
      airbnb("Hotel/Hostel"),
      ["the 'Hotel/Hostel' row in the Property Type dropdown"],
    ),
    null,
  );
});

test("GATE domain size (2ec6c1c0 #8): a measured reading on a small category set still abstains", () => {
  assert.equal(
    contradictsFilterState(
      "Apartment avg beds = 2.6 (West) and 2.9 (East)",
      airbnb("Hotel/Hostel"),
      ["the 'Hotel/Hostel' row in the Property Type dropdown"],
    ),
    null,
  );
});

// --- base constraints ------------------------------------------------------

test("a text naming BOTH values is a comparison, not a contradiction", () => {
  assert.equal(
    contradictsFilterState(
      "13 Reasons Why is 3 Seasons and American Horror Story is 9 Seasons",
      netflix("13 Reasons Why"),
      ["the '13 Reasons Why' row in the Title dropdown"],
    ),
    null,
  );
});

test("a filter with several values applied constrains nothing readable", () => {
  const inv = netflix("13 Reasons Why");
  inv.filters[0].applied = ["13 Reasons Why", "American Horror Story"];
  assert.equal(
    contradictsFilterState("American Horror Story duration = 9 Seasons", inv, ["13 Reasons Why"]),
    null,
  );
});

test("matching is word-bounded, not substring", () => {
  // "American Horror" is a domain value in its own right on some workbooks, and
  // it is a prefix of "American Horrorshow" - matching that would invent a
  // contradiction out of a longer word that merely starts the same way.
  const inv = netflix("13 Reasons Why");
  inv.filters[0].domain = [...inv.filters[0].domain, "American Horror"];
  assert.equal(
    contradictsFilterState(
      "American Horrorshow ratings average 4 stars",
      inv,
      ["the '13 Reasons Why' row in the Title dropdown"],
    ),
    null,
  );
});

test("a reading that names no other entity is not a contradiction", () => {
  assert.equal(
    contradictsFilterState(
      "13 Reasons Why duration = 3 Seasons",
      netflix("13 Reasons Why"),
      ["the '13 Reasons Why' row in the Title dropdown"],
    ),
    null,
  );
});

test("range filters and empty inputs are ignored", () => {
  assert.equal(contradictsFilterState("anything", { filters: [{ id: "F1", field: "Year", type: "range" }] }, []), null);
  assert.equal(contradictsFilterState("", netflix("13 Reasons Why"), ["13 Reasons Why"]), null);
  assert.equal(contradictsFilterState("American Horror Story = 9", null, []), null);
  assert.equal(contradictsFilterState("American Horror Story = 9", netflix("13 Reasons Why"), null), null);
});

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

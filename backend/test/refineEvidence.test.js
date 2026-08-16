// The evidence gate on the zoom-refine reply.
//
// The bug it exists for, observed on the Netflix "Movies and TV Shows" dashboard
// on 2026-08-16: the model named "the Type dropdown" (a control in the top-left
// corner) while aiming at (0.69,0.44), the middle of the frame. REFINE_WINDOW is
// 22% of the frame, so the crop physically could not contain that control - the
// only honest answers were {"found": false} or nothing. Instead the model
// returned a confident {"found": true} pointing at the bubble chart that WAS in
// the crop, and because refine leads the click path, that reply short-circuited
// locate - the one pass that could have reached the corner. The agent clicked
// the "Movie" bubble, the pixels changed, and the step was recorded as a
// success.
//
// A find must now carry `match`: the text or feature the model says it matched
// on. An unevidenced find is reported as notFound so it ESCALATES to the
// whole-frame search, rather than being executed as if verified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretRefineResponse } from "../src/vlmClient.js";

// The crop as SENT: upscaled to REFINE_LONG_SIDE, which is what the model's
// pixel-space answers (when it gives one) are relative to.
const CROP = { width: 1024, height: 1024 };

test("an evidenced find is accepted, with its coordinates and its evidence", () => {
  const out = interpretRefineResponse(
    { found: true, match: "Type", nx: 0.51, ny: 0.34 },
    CROP,
  );
  assert.deepEqual(out, { nx: 0.51, ny: 0.34, match: "Type" });
});

test("an explicit not-here stays a verdict about the crop", () => {
  assert.deepEqual(interpretRefineResponse({ found: false }, CROP), { notFound: true });
});

test("a find with NO match is not a find - this is the Netflix bubble bluff", () => {
  // The exact reply shape that got the "Movie" bubble clicked.
  assert.deepEqual(
    interpretRefineResponse({ found: true, nx: 0.52, ny: 0.49 }, CROP),
    { notFound: true },
  );
});

test("an empty or whitespace match is no evidence either", () => {
  for (const match of ["", "   ", "\n"]) {
    assert.deepEqual(
      interpretRefineResponse({ found: true, match, nx: 0.5, ny: 0.5 }, CROP),
      { notFound: true },
      `match=${JSON.stringify(match)} should not count as evidence`,
    );
  }
});

test("a non-string match is no evidence", () => {
  // Seen from models that "helpfully" structure the field instead of quoting.
  for (const match of [true, 1, null, { text: "Type" }, ["Type"]]) {
    assert.deepEqual(
      interpretRefineResponse({ found: true, match, nx: 0.5, ny: 0.5 }, CROP),
      { notFound: true },
    );
  }
});

test("notFound is used rather than null, so the caller ESCALATES to locate", () => {
  // The distinction is the whole point: clickAiming treats notFound and null
  // identically at this step (both go to locate), but returning null here would
  // read as "the refine call itself broke", which is a different fact and is
  // logged differently. Assert the shape so a later "simplification" to null
  // has to argue with this test.
  const out = interpretRefineResponse({ found: true, nx: 0.5, ny: 0.5 }, CROP);
  assert.equal(out.notFound, true);
  assert.equal(out.nx, undefined, "no coordinates may leak out of an unevidenced find");
});

test("the magnitude rescue still applies to an evidenced find", () => {
  // Same slip as everywhere else: the model writes 0-1000 space as readily as
  // fractions. The evidence gate must not swallow a real answer.
  const out = interpretRefineResponse(
    { found: true, match: "Advanced degree", nx: 510, ny: 340 },
    CROP,
  );
  assert.equal(out.match, "Advanced degree");
  assert.ok(Math.abs(out.nx - 0.51) < 1e-9, `${out.nx} ≉ 0.51`);
  assert.ok(Math.abs(out.ny - 0.34) < 1e-9, `${out.ny} ≉ 0.34`);
});

test("evidence without usable coordinates is null, not a find", () => {
  // The call produced no answer we can act on, which is NOT a verdict about
  // whether the target is in the crop.
  assert.equal(interpretRefineResponse({ found: true, match: "Type" }, CROP), null);
  assert.equal(
    interpretRefineResponse({ found: true, match: "Type", nx: -0.1, ny: 0.4 }, CROP),
    null,
  );
});

test("nothing parsed is null", () => {
  assert.equal(interpretRefineResponse(null, CROP), null);
});

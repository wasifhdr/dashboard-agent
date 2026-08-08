import test from "node:test";
import assert from "node:assert/strict";

import { settleDecision } from "../src/perception.js";

// Baseline the real dashboards produce: a mark click's action filter lands
// ~2.3-3.3s later (measured on Video Game Sales), and the bridge fires
// filterchanged at that same moment. The pixels go quiet ~1.1s in - after the
// local highlight repaint, before the server round-trip - which is the window
// this decision has to refuse to settle in.
const CFG = { eventQuietMs: 700, eventGraceMs: 4500 };

test("never settles while pixels are still moving", () => {
  for (const expectBridgeEvent of [false, true]) {
    assert.equal(
      settleDecision({ pixelsStable: false, expectBridgeEvent, sawEvent: true, msSinceLastEvent: 9999, elapsedMs: 9999, ...CFG }),
      "wait",
    );
  }
});

test("load path (no action taken) settles as soon as pixels are stable", () => {
  // Unchanged legacy behavior - the initial settle after openSession must not
  // start paying the post-action grace period.
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: false, sawEvent: false, msSinceLastEvent: null, elapsedMs: 1100, ...CFG }),
    "settled",
  );
});

test("REGRESSION: does not settle in the quiet gap before the action filter lands", () => {
  // The exact failure: at ~1.1s the highlight repaint is done and no bridge
  // event has arrived yet, so pixels look stable. Settling here screenshots an
  // unfiltered dashboard that merely LOOKS filtered.
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: true, sawEvent: false, msSinceLastEvent: null, elapsedMs: 1120, ...CFG }),
    "wait",
  );
});

test("does not settle immediately after the event fires - the repaint follows it", () => {
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: true, sawEvent: true, msSinceLastEvent: 120, elapsedMs: 2800, ...CFG }),
    "wait",
  );
});

test("settles once the event has landed and gone quiet", () => {
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: true, sawEvent: true, msSinceLastEvent: 700, elapsedMs: 3400, ...CFG }),
    "settled",
  );
});

test("gives up waiting for an event once the grace window expires (dead click)", () => {
  // A click that hits nothing fires no event ever. It must not hang until the
  // full 12s settle timeout.
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: true, sawEvent: false, msSinceLastEvent: null, elapsedMs: 4500, ...CFG }),
    "settled",
  );
});

test("grace window covers the slowest propagation actually measured", () => {
  // Slowest observed action-filter landing was 3327ms. The grace must not
  // expire before that, or a slow-but-healthy filter gets screenshotted early.
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: true, sawEvent: false, msSinceLastEvent: null, elapsedMs: 3327, ...CFG }),
    "wait",
  );
});

test("a second event restarts the quiet window", () => {
  // Tableau fires filterchanged several times in a burst; the quiet period is
  // measured from the LAST one, so a burst cannot be mistaken for completion.
  assert.equal(
    settleDecision({ pixelsStable: true, expectBridgeEvent: true, sawEvent: true, msSinceLastEvent: 5, elapsedMs: 6000, ...CFG }),
    "wait",
  );
});

// Phase 0 acceptance probe: proves every risky primitive end-to-end on a
// real Tableau Public dashboard - load, inventory, screenshot, apply a
// filter, settle, screenshot again, diff.
//
// Usage: node probe.js <tableau-views-url>
// Requires: the backend running (npm run dev) for the host page. No VLM is
// involved - this only exercises perception and bridge actuation.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBrowser, openSession, waitForSettle, screenshotViz, computeChangedRegions } from "./src/perception.js";
import { createInventoryTracker } from "./src/inventory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));

const vizUrl = process.argv[2];
if (!vizUrl) {
  console.error("Usage: node probe.js <tableau-views-url>");
  process.exit(1);
}

const runSlug = vizUrl.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
const outDir = path.join(__dirname, "data", "frames", `_probe_${runSlug}`);
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const browser = await launchBrowser();
  const tracker = createInventoryTracker();

  console.log(`\n=== Opening ${vizUrl} ===`);
  const { page } = await openSession(browser, config.hostPageOrigin, vizUrl);
  console.log("Viz interactive.");

  const beforePath = path.join(outDir, "before.png");
  await screenshotViz(page, beforePath);
  console.log(`Screenshot: ${beforePath}`);

  const rawInv1 = await page.evaluate(() => window.__agentBridge.getInventory());
  const inv1 = tracker.normalize(rawInv1);
  console.log("\n--- Inventory (before) ---");
  console.log(
    JSON.stringify(
      { activeSheet: inv1.activeSheet, sheets: inv1.sheets, filterCount: inv1.filters.length, paramCount: inv1.parameters.length },
      null,
      2,
    ),
  );
  console.log(`(${inv1.filters.length} filters, ${inv1.parameters.length} parameters - full inventory below)`);
  console.log(JSON.stringify(inv1, null, 2));

  const target = inv1.filters.find(
    (f) => f.operable && f.type === "categorical" && f.domain && f.domain.length >= 2,
  );

  if (!target) {
    console.log(
      "\nNo operable categorical filter with an enumerable domain found on this dashboard; skipping action/settle/diff test.",
    );
  } else {
    const candidate = target.domain.find((v) => !target.applied.includes(v)) ?? target.domain[0];
    console.log(`\n=== Applying filter: ${target.field} = [${candidate}] (was ${JSON.stringify(target.applied)}) ===`);

    const result = await page.evaluate(
      ({ field, values }) => window.__agentBridge.applyCategoricalFilter(field, values),
      { field: target.field, values: [candidate] },
    );
    console.log("applyCategoricalFilter result:", result);

    console.log("Waiting for settle...");
    // A filter was just applied, so the settle gate must wait out the server
    // round-trip too - otherwise the diff below can come back empty and the
    // probe reports a working dashboard as unresponsive.
    const settle = await waitForSettle(page, config.settleGate, { expectBridgeEvent: true });
    console.log("Settle result:", settle);

    const afterPath = path.join(outDir, "after.png");
    await screenshotViz(page, afterPath);
    console.log(`Screenshot: ${afterPath}`);

    const rawInv2 = await page.evaluate(() => window.__agentBridge.getInventory());
    const inv2 = tracker.normalize(rawInv2);
    const target2 = inv2.filters.find((f) => f.id === target.id);
    console.log("\n--- Filter state after action ---");
    console.log(JSON.stringify(target2, null, 2));

    const regions = await computeChangedRegions(beforePath, afterPath);
    console.log("\n--- Changed regions (before -> after), coarse bounding boxes ---");
    console.log(JSON.stringify(regions, null, 2));
  }

  const events = await page.evaluate(() => window.__agentBridge.getEventLog());
  console.log("\n--- Event log ---");
  console.log(JSON.stringify(events, null, 2));

  await browser.close();
  console.log(`\n=== Probe complete. Frames in ${outDir} ===`);
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exit(1);
});

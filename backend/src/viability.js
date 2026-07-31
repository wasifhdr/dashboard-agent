// Read-only viability check for a dashboard the user opened from search.
// Unlike probe.js this applies no filters, opens no browser, and closes
// nothing - it inspects the session's own live page and reports.
//
// The point is narrow: tell the user when the thing they opened is something
// the agent structurally cannot work, before they spend a question on it.

import fs from "node:fs";
import sharp from "sharp";
import { screenshotViz } from "./perception.js";
import { createInventoryTracker } from "./inventory.js";

export function deriveVerdict({ activeSheetType, inventory, blankFrame }) {
  const facts = {
    activeSheetType: activeSheetType ?? null,
    isDashboard: inventory?.isDashboard ?? null,
    sheetCount: inventory?.sheets?.length ?? null,
    operableControlCount: inventory
      ? (inventory.filters ?? []).filter((f) => f.operable).length + (inventory.parameters ?? []).length
      : null,
    blankFrame: Boolean(blankFrame),
  };

  // Nothing painted: whatever else is true, there is nothing to read.
  if (blankFrame) {
    return { verdict: "unusable", reasons: ["blank_frame"], facts };
  }

  // No action in actionSchema.js advances a story point, so a story is
  // structurally unusable rather than merely awkward. Checked before the
  // inventory because getInventory() itself throws on a story sheet.
  if (activeSheetType === "story") {
    return { verdict: "unusable", reasons: ["story"], facts };
  }

  // Everything below needs an inventory; without one we genuinely don't know.
  if (!inventory) {
    return { verdict: "unknown", reasons: ["no_inventory"], facts };
  }

  // Nothing else predicts failure in pixel mode. A bare worksheet is readable,
  // and a dashboard with no bridge-visible filters is still clickable - the
  // agent filters by clicking marks, not by operating filter objects. Those
  // counts stay in `facts` for the log rather than becoming a warning.
  return { verdict: "good", reasons: [], facts };
}

// A frame where every channel is essentially constant means the viz element
// exists but painted nothing (deleted extract, auth wall, error tile). Real
// dashboards have text and marks, so their standard deviation is far above this.
const BLANK_STDEV_MAX = 2;

async function isBlankFrame(imagePath) {
  try {
    const { channels } = await sharp(imagePath).stats();
    return channels.every((c) => c.stdev < BLANK_STDEV_MAX);
  } catch {
    // Unreadable screenshot is not evidence of blankness.
    return false;
  }
}

// Read the active sheet's type straight off the embed element. Deliberately
// does NOT go through __agentBridge.getInventory(), which calls getFiltersAsync
// unguarded and therefore throws on a Story - the exact case we most need to
// detect. The element id is "agentViz", never "viz" (Tableau's own internal
// iframe reuses "viz").
async function readActiveSheetType(page) {
  try {
    return await page.evaluate(() => {
      const el = document.getElementById("agentViz");
      return el?.workbook?.activeSheet?.sheetType ?? null;
    });
  } catch {
    return null;
  }
}

export async function inspectViz(page, { screenshotPath }) {
  try {
    const activeSheetType = await readActiveSheetType(page);

    // Short-circuit before touching the bridge: on a story it would throw.
    if (activeSheetType === "story") {
      return deriveVerdict({ activeSheetType, inventory: null, blankFrame: false });
    }

    await screenshotViz(page, screenshotPath);
    const blankFrame = await isBlankFrame(screenshotPath);

    let inventory = null;
    try {
      const raw = await page.evaluate(() => window.__agentBridge.getInventory());
      inventory = createInventoryTracker().normalize(raw);
      // normalize() intentionally drops isDashboard (only activeSheet/sheets/
      // filters/parameters are its contract with the orchestrator), so carry
      // it over from the raw bridge payload for the viability facts log.
      inventory.isDashboard = raw?.isDashboard ?? null;
    } catch {
      // Leave null - deriveVerdict reports "unknown" rather than guessing.
    }

    return deriveVerdict({ activeSheetType, inventory, blankFrame });
  } catch (e) {
    // Inspection is advisory. It must never take a session down.
    return {
      verdict: "unknown",
      reasons: ["inspection_failed"],
      facts: { error: e.message },
    };
  } finally {
    fs.rm(screenshotPath, { force: true }, () => {});
  }
}

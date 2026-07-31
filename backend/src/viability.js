// Read-only viability check for a dashboard the user opened from search.
// Unlike probe.js this applies no filters, opens no browser, and closes
// nothing - it inspects the session's own live page and reports.
//
// The point is narrow: tell the user when the thing they opened is something
// the agent structurally cannot work, before they spend a question on it.

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

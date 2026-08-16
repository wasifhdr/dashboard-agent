// Translates a validated action + its resolved inventory entry into a
// window.__agentBridge call, executed inside the Playwright page.

// Must match id on <tableau-viz id="agentViz"> in public/host.html.
// Duplicated (not imported) because perception.js is frozen and does not
// export its VIZ_SELECTOR — same rationale as conversationRuntime.js.
const VIZ_SELECTOR = "tableau-viz#agentViz";

// Pure transform: a normalized [0,1] point over the viz image -> absolute page
// pixels, using the viz element's bounding box. Same math family as
// conversationRuntime.dispatchInput.
export function vizPointToPagePixels(box, nx, ny) {
  return { px: box.x + nx * box.width, py: box.y + ny * box.height };
}

function findCaseInsensitive(domain, value) {
  return domain.find((d) => String(d).toLowerCase() === String(value).toLowerCase());
}

function nearMatches(domain, value) {
  const needle = String(value).toLowerCase();
  return domain.filter((d) => {
    const hay = String(d).toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  }).slice(0, 5);
}

// The focused text entry, searched across every frame because the search box
// lives inside the cross-origin Tableau iframe. Returns null when nothing
// editable has focus, which is the signal to reject a search WITHOUT typing.
//
// A frame can detach mid-iteration during load, so a throwing frame is skipped
// rather than fatal - observed repeatedly while probing.
export async function findFocusedTextEntry(page) {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const tag = el.tagName.toLowerCase();
        const editable =
          tag === "input" ||
          tag === "textarea" ||
          el.getAttribute("role") === "textbox" ||
          el.isContentEditable;
        if (!editable) return null;
        return { tag, cls: (el.className?.toString?.() ?? "").slice(0, 80), value: el.value ?? "" };
      });
      if (found) return { frame, ...found };
    } catch {
      // detached frame; try the next
    }
  }
  return null;
}

async function executeAction(page, resolved, action, opts = {}) {
  try {
    switch (action.type) {
      case "set_filter": {
        if (!resolved || resolved.kind !== "filter") {
          return { ok: false, error: `${action.target_id} is not a known filter id.` };
        }
        if (resolved.type !== "categorical") {
          return { ok: false, error: `${action.target_id} is a "${resolved.type}" filter, not categorical - use set_range_filter for range filters.` };
        }

        let values = action.values;
        if (resolved.domain && resolved.domain.length) {
          const resolvedValues = [];
          const unmatched = [];
          for (const v of values) {
            const match = findCaseInsensitive(resolved.domain, v);
            if (match) resolvedValues.push(match);
            else unmatched.push(v);
          }
          if (unmatched.length) {
            const suggestions = unmatched.map((v) => ({ value: v, suggestions: nearMatches(resolved.domain, v) }));
            return {
              ok: false,
              error: `Value(s) not found in the known domain for ${action.target_id} ("${resolved.field}"): ${unmatched.join(", ")}.`,
              nearMatches: suggestions,
            };
          }
          values = resolvedValues;
        }

        const res = await page.evaluate(
          ({ field, values }) => window.__agentBridge.applyCategoricalFilter(field, values),
          { field: resolved.field, values },
        );
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }

      case "set_range_filter": {
        if (!resolved || resolved.kind !== "filter") {
          return { ok: false, error: `${action.target_id} is not a known filter id.` };
        }
        if (resolved.type !== "range") {
          return { ok: false, error: `${action.target_id} is a "${resolved.type}" filter, not range - use set_filter for categorical filters.` };
        }

        const min = action.min ?? resolved.domainMin;
        const max = action.max ?? resolved.domainMax;
        const res = await page.evaluate(
          ({ field, min, max }) => window.__agentBridge.applyRangeFilter(field, min, max),
          { field: resolved.field, min: Number(min), max: Number(max) },
        );
        return res.ok ? { ok: true } : { ok: false, error: res.error || JSON.stringify(res.results) };
      }

      case "set_parameter": {
        if (!resolved || resolved.kind !== "parameter") {
          return { ok: false, error: `${action.target_id} is not a known parameter id.` };
        }

        let value = action.value;
        if (resolved.allowable && resolved.allowable.length) {
          const match = findCaseInsensitive(resolved.allowable, value);
          if (!match) {
            return {
              ok: false,
              error: `Value "${value}" is not an allowable value for ${action.target_id} ("${resolved.name}").`,
              nearMatches: [{ value, suggestions: nearMatches(resolved.allowable, value) }],
            };
          }
          value = match;
        }

        const res = await page.evaluate(
          ({ name, value }) => window.__agentBridge.setParameter(name, value),
          { name: resolved.name, value },
        );
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }

      case "switch_sheet": {
        if (!resolved || resolved.kind !== "sheet") {
          return { ok: false, error: `${action.target_id} is not a known sheet id.` };
        }
        const res = await page.evaluate((name) => window.__agentBridge.switchSheet(name), resolved.name);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }

      case "click": {
        const box = await page.locator(VIZ_SELECTOR).boundingBox();
        if (!box || !box.width || !box.height) {
          return { ok: false, error: "Viz element not measurable right now (mid-transition); try again." };
        }
        const { px, py } = vizPointToPagePixels(box, action.nx, action.ny);
        await page.mouse.move(px, py, { steps: 12 });
        await page.mouse.click(px, py);
        return { ok: true, point: { nx: action.nx, ny: action.ny, px, py } };
      }

      case "scroll": {
        const box = await page.locator(VIZ_SELECTOR).boundingBox();
        if (!box || !box.width || !box.height) {
          return { ok: false, error: "Viz element not measurable right now (mid-transition); try again." };
        }
        const { px, py } = vizPointToPagePixels(box, action.nx, action.ny);
        const notch = Number(opts.notchPx) > 0 ? Number(opts.notchPx) : 300;
        // move() first is REQUIRED: wheel() dispatches at the current cursor
        // position, so without it the wheel lands wherever the mouse was left.
        await page.mouse.move(px, py, { steps: 12 });
        // Hook between the move and the wheel. Moving the cursor onto a pane
        // leaves a highlight on the row beneath it, and that highlight persists
        // even after the cursor leaves - so a caller that needs to tell a real
        // scroll from our own hover artifact must baseline HERE, with the
        // artifact already present. Nothing else belongs in this window.
        if (typeof opts.beforeWheel === "function") await opts.beforeWheel();
        await page.mouse.wheel(0, action.direction === "up" ? -notch : notch);
        return { ok: true, point: { nx: action.nx, ny: action.ny, px, py } };
      }

      case "search": {
        // No mouse at all. The box is focused the instant the dropdown opens, so
        // aiming at it buys nothing and risks everything: a click 2% of frame height
        // below its centre was measured selecting a title and closing the list.
        const focused = await findFocusedTextEntry(page);
        if (!focused) {
          return {
            ok: false,
            error:
              "No text box is focused, so nothing was typed. Open the filter dropdown first - " +
              "its search box is focused automatically when the list opens.",
          };
        }
        // PACING IS THE FEATURE. Tableau's search pipeline needs real wall-clock time
        // between characters to keep up with the box: at 40ms/char with Enter pressed
        // immediately this lands a clean match 2 times in 8; at 250ms/char with a
        // 1500ms pause before Enter, 7 times in 8. CDP insertText and raw per-char
        // dispatchKeyEvent both sat at 2/8 too, so it is not the event type - do not
        // "optimize" these delays away.
        const typeDelayMs = Number(opts.typeDelayMs) > 0 ? Number(opts.typeDelayMs) : 250;
        const syncMs = Number(opts.syncMs) >= 0 ? Number(opts.syncMs) : 1500;

        // Control+a so a second search replaces the prior term instead of appending;
        // a no-op on an empty box.
        await page.keyboard.press("Control+a");
        await page.keyboard.type(action.text, { delay: typeDelayMs });
        // Let Tableau's own filter state catch up with what was typed before
        // committing. Under this pacing the list has usually filtered ALREADY by now.
        await page.waitForTimeout(syncMs);
        // Enter as a cheap safety net rather than the trigger - it finishes the job on
        // the runs where the live filter has not landed on its own.
        await page.keyboard.press("Enter");

        // No newline check. It looked like an exact witness at n=6 and collapsed at
        // n=8: a success with a newline present, a success without one, and six
        // failures all with one. The caller judges by the pixel diff alone.
        return { ok: true, text: action.text };
      }

      default:
        return { ok: false, error: `Unsupported action type "${action.type}" for direct execution.` };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// `opts` carries execution parameters that are NOT part of the model's validated
// action - opts.notchPx (the wheel delta for a scroll) and opts.beforeWheel (a
// hook awaited between the cursor move and the wheel). Kept off the action object
// so what the schema validated is exactly what gets executed and persisted.
export async function executeActionWithTimeout(page, resolved, action, timeoutMs, opts = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `Action timed out after ${timeoutMs}ms.` }), timeoutMs);
  });
  try {
    return await Promise.race([executeAction(page, resolved, action, opts), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function describeAction(action, resolved) {
  switch (action.type) {
    case "set_filter":
      return `Filter: ${resolved?.field ?? action.target_id} = ${action.values.join(", ")}`;
    case "set_range_filter":
      return `Filter: ${resolved?.field ?? action.target_id} = [${action.min ?? resolved?.domainMin} .. ${action.max ?? resolved?.domainMax}]`;
    case "set_parameter":
      return `Parameter: ${resolved?.name ?? action.target_id} = ${action.value}`;
    case "switch_sheet":
      return `Switch to sheet: ${resolved?.name ?? action.target_id}`;
    case "wait":
      return "Wait";
    case "answer":
      return "Answer";
    case "fail":
      return `Fail${action.reason ? `: ${action.reason}` : ""}`;
    case "click":
      return `Click: ${action.target ?? `(${action.nx.toFixed(3)}, ${action.ny.toFixed(3)})`}`;
    case "scroll":
      return `Scroll ${action.direction}${action.target ? `: ${action.target}` : ` (${action.nx.toFixed(3)}, ${action.ny.toFixed(3)})`}`;
    case "search":
      return `Search: ${JSON.stringify(action.text)}`;
    default:
      return action.type;
  }
}

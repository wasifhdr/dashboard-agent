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

async function executeAction(page, resolved, action) {
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

      default:
        return { ok: false, error: `Unsupported action type "${action.type}" for direct execution.` };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function executeActionWithTimeout(page, resolved, action, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `Action timed out after ${timeoutMs}ms.` }), timeoutMs);
  });
  try {
    return await Promise.race([executeAction(page, resolved, action), timeout]);
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
    default:
      return action.type;
  }
}

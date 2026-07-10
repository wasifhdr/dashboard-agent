// Normalizes the bridge's raw getInventory() output into the stable-ID
// control inventory contract (AGENT_PLAN.md 6.1) that the VLM prompt and
// action schema are built against.

function nextId(map, prefix, key) {
  if (map.has(key)) return map.get(key);
  const id = `${prefix}${map.size + 1}`;
  map.set(key, id);
  return id;
}

// Returns a tracker whose normalize() assigns IDs that stay stable across
// repeated calls within one session (e.g. the same "Year" filter keeps its
// F-id even after a sheet switch and back), by keying on name.
export function createInventoryTracker() {
  const sheetIds = new Map();
  const filterIds = new Map();
  const paramIds = new Map();
  // id -> latest normalized entry, tagged with `kind`. Lets the orchestrator
  // /actuator translate an action's target_id back into the real Tableau
  // field/parameter/sheet name without re-deriving it.
  const latestById = new Map();

  function normalize(raw) {
    const sheets = (raw.sheets || []).map((s) => {
      const id = nextId(sheetIds, "S", s.name);
      const entry = {
        id,
        name: s.name,
        type: s.sheetType,
        active: Boolean(s.isActive) || s.name === raw.activeSheetName,
      };
      latestById.set(id, { kind: "sheet", ...entry });
      return entry;
    });

    // Merge same-field filters across worksheets into one inventory entry.
    const byField = new Map();
    for (const f of raw.filters || []) {
      if (!byField.has(f.fieldName)) {
        byField.set(f.fieldName, {
          fieldName: f.fieldName,
          type: f.filterType,
          worksheets: new Set(),
          appliedValues: new Set(),
          isAllSelected: false,
          domain: null,
          domainRange: null,
          minValue: null,
          maxValue: null,
        });
      }
      const entry = byField.get(f.fieldName);
      entry.worksheets.add(f.worksheetName);
      if (f.isAllSelected) entry.isAllSelected = true;
      for (const v of f.appliedValues || []) entry.appliedValues.add(v);
      if (!entry.domain && f.domain && f.domain.length) entry.domain = f.domain;
      if (!entry.domainRange && f.domainRange) entry.domainRange = f.domainRange;
      if (f.minValue != null) entry.minValue = f.minValue;
      if (f.maxValue != null) entry.maxValue = f.maxValue;
    }

    const filters = [...byField.values()].map((entry) => {
      const id = nextId(filterIds, "F", entry.fieldName);
      const operable = entry.type === "categorical" || entry.type === "range";
      const base = {
        id,
        field: entry.fieldName,
        type: entry.type,
        operable,
        worksheets: [...entry.worksheets],
      };

      let full;
      if (entry.type === "categorical") {
        full = {
          ...base,
          applied: entry.isAllSelected || entry.appliedValues.size === 0 ? ["(All)"] : [...entry.appliedValues],
          domain: entry.domain, // null if not enumerable -> agent must read options from the screenshot
        };
      } else if (entry.type === "range") {
        full = {
          ...base,
          appliedMin: entry.minValue,
          appliedMax: entry.maxValue,
          domainMin: entry.domainRange?.min ?? null,
          domainMax: entry.domainRange?.max ?? null,
        };
      } else {
        // hierarchical / relative-date: surfaced for context only, not
        // operable via the current action schema (AGENT_PLAN.md 6.2).
        full = base;
      }
      latestById.set(id, { kind: "filter", ...full });
      return full;
    });

    const parameters = (raw.parameters || []).map((p) => {
      const id = nextId(paramIds, "P", p.name);
      const entry = {
        id,
        name: p.name,
        type: p.allowableType, // "list" | "range" | "all"
        current: p.currentValue,
        allowable: p.allowableValues && p.allowableValues.length ? p.allowableValues : null,
        min: p.minValue ?? null,
        max: p.maxValue ?? null,
        step: p.stepSize ?? null,
      };
      latestById.set(id, { kind: "parameter", ...entry });
      return entry;
    });

    return {
      activeSheet: raw.activeSheetName,
      sheets,
      filters,
      parameters,
    };
  }

  // Translates a target_id from a validated action back into the current
  // Tableau field/parameter/sheet name and metadata, for the actuator to
  // execute against. Reflects whatever the most recent normalize() call saw.
  function resolve(id) {
    return latestById.get(id) ?? null;
  }

  return { normalize, resolve };
}

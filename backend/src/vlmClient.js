import fs from "node:fs";
import sharp from "sharp";
import { StepResponseSchema } from "./actionSchema.js";

// ---- inventory / history formatting (AGENT_PLAN.md 6.8) --------------------

function truncateList(list, max = 30) {
  if (!list) return null;
  if (list.length <= max) return list;
  return [...list.slice(0, max), `... (+${list.length - max} more)`];
}

function formatInventoryForPrompt(inventory) {
  const lines = [];

  lines.push("SHEETS:");
  for (const s of inventory.sheets) {
    lines.push(`- ${s.id} "${s.name}" (${s.type})${s.active ? " [ACTIVE]" : ""}`);
  }

  lines.push("", "FILTERS:");
  if (inventory.filters.length === 0) lines.push("(none)");
  for (const f of inventory.filters) {
    if (f.type === "categorical") {
      const dom = truncateList(f.domain);
      lines.push(
        `- ${f.id} field="${f.field}" type=categorical applied=${JSON.stringify(f.applied)} ` +
          `domain=${dom ? JSON.stringify(dom) : "unknown (read the visible options from the screenshot)"}`,
      );
    } else if (f.type === "range") {
      lines.push(
        `- ${f.id} field="${f.field}" type=range applied=[${f.appliedMin ?? "?"} .. ${f.appliedMax ?? "?"}] ` +
          `domain=[${f.domainMin ?? "?"} .. ${f.domainMax ?? "?"}]`,
      );
    } else {
      lines.push(`- ${f.id} field="${f.field}" type=${f.type} (not settable by an action; read its state from the screenshot)`);
    }
  }

  lines.push("", "PARAMETERS:");
  if (inventory.parameters.length === 0) lines.push("(none)");
  for (const p of inventory.parameters) {
    if (p.type === "list") {
      lines.push(
        `- ${p.id} name="${p.name}" type=list current=${JSON.stringify(p.current)} ` +
          `allowable=${JSON.stringify(truncateList(p.allowable) ?? [])}`,
      );
    } else if (p.type === "range") {
      lines.push(
        `- ${p.id} name="${p.name}" type=range current=${JSON.stringify(p.current)} min=${p.min} max=${p.max}` +
          (p.step ? ` step=${p.step}` : ""),
      );
    } else {
      lines.push(`- ${p.id} name="${p.name}" type=${p.type ?? "unknown"} current=${JSON.stringify(p.current)}`);
    }
  }

  return lines.join("\n");
}

function describeActionForHistory(h) {
  if (h.values !== undefined) return `${h.target_id}=${JSON.stringify(h.values)}`;
  if (h.value !== undefined) return `${h.target_id}=${JSON.stringify(h.value)}`;
  if (h.min !== undefined || h.max !== undefined) return `${h.target_id}=[${h.min ?? "?"}..${h.max ?? "?"}]`;
  if (h.target_id) return h.target_id;
  return "";
}

function formatHistoryLine(h) {
  const detail = describeActionForHistory(h);
  return `#${h.idx} ${h.type}${detail ? " " + detail : ""} -> ${h.status}`;
}

const SYSTEM_TEMPLATE = (question) => `You are an agent that answers a question about a live, interactive Tableau dashboard by operating its filters, parameters, and tabs, then answering.

QUESTION: "${question}"

On each turn you are shown:
- The current dashboard screenshot
- An inventory of the controls you can operate, each with a stable id (e.g. F1, P2, S1)
- A short history of your previous actions and their outcomes

Respond with STRICT JSON ONLY (no markdown, no extra commentary, no text outside the JSON object), matching exactly this shape:
{"thought": "<= 2 sentences explaining your reasoning", "action": { ... }}

The "action" object must be exactly one of these shapes:
- {"type":"set_filter","target_id":"F1","values":["Asia"]}
- {"type":"set_range_filter","target_id":"F2","min":2015,"max":2020}
- {"type":"set_parameter","target_id":"P1","value":"Profit"}
- {"type":"switch_sheet","target_id":"S2"}
- {"type":"wait"}
- {"type":"answer","answer":"<final answer text>","confidence":0.8}
- {"type":"fail","reason":"<why this cannot be answered from this dashboard>"}

Rules:
1. Exactly one action per turn.
2. Only use target_id values that appear in the CURRENT inventory below - ids can change between turns if the dashboard changes.
3. Prefer "answer" as soon as the current screenshot shows everything needed - do not take extra actions once you already have enough information.
4. Never repeat an action you have already performed successfully - check the history below first; repeating is rejected and wastes a turn.
5. Only use "wait" if the dashboard visibly appears to still be loading or updating; never use it more than twice in a row.
6. Only use "fail" if the question is genuinely unanswerable from this dashboard after exploring it.
7. set_filter is for categorical filters only; set_range_filter is for range (numeric/date) filters only - check each filter's "type" in the inventory.`;

function buildPrompt({ question, inventory, history, correctiveFeedback }) {
  const systemText = SYSTEM_TEMPLATE(question);
  const historyText = history.length ? history.map(formatHistoryLine).join("\n") : "(no actions taken yet)";
  const invText = formatInventoryForPrompt(inventory);

  let userText = `CURRENT INVENTORY:\n${invText}\n\nHISTORY:\n${historyText}\n`;
  if (correctiveFeedback) {
    userText += `\nFEEDBACK ON YOUR LAST RESPONSE:\n${correctiveFeedback}\n`;
  }
  userText += `\nRespond with the JSON object now.`;

  return { systemText, userText };
}

// ---- JSON extraction (handles a model that leaks preamble/think text) ------

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Scans backward for the last balanced {...} block and parses it. Tolerates
// leading non-JSON text (e.g. a leaked <think>...</think> block) even when
// response_format wasn't set to force pure JSON.
function extractLastJsonObject(text) {
  if (!text) return null;
  let searchEnd = text.lastIndexOf("}");
  while (searchEnd !== -1) {
    let depth = 0;
    for (let i = searchEnd; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, searchEnd + 1);
          const parsed = tryParseJson(candidate);
          if (parsed) return parsed;
          break;
        }
      }
    }
    searchEnd = text.lastIndexOf("}", searchEnd - 1);
  }
  return null;
}

function parseModelJson(raw) {
  return tryParseJson((raw || "").trim()) ?? extractLastJsonObject(raw);
}

// ---- image handling ---------------------------------------------------

async function resizeImageToDataUrl(imagePath, longSide) {
  const buf = await sharp(imagePath)
    .resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// ---- llama-server call --------------------------------------------------

async function callVlm({ config, systemText, userText, imagePath }) {
  const imageDataUrl = await resizeImageToDataUrl(imagePath, config.imageLongSide);

  const payload = {
    model: config.modelName,
    messages: [
      { role: "system", content: systemText },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 768,
  };

  if (config.promptStyle === "constrained_json") {
    payload.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.vlmCallTimeoutMs);
  try {
    const res = await fetch(`${config.llamaEndpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`llama-server error ${res.status}: ${bodyText.slice(0, 800)}`);
    }
    const json = JSON.parse(bodyText);
    return json?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ---- public: get the next validated action, with a bounded re-prompt policy

// Up to 3 total attempts (1 initial + 2 re-prompts) before giving up
// (AGENT_PLAN.md 6.2: "up to 2 re-prompts... a 3rd failure records the step
// as invalid_json").
export async function getNextAction({ config, question, inventory, history, imagePath, correctiveFeedback, onAttempt = () => {} }) {
  let feedback = correctiveFeedback;
  let lastRaw = null;
  let lastNetworkError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt >= 2) onAttempt(attempt);
    const { systemText, userText } = buildPrompt({ question, inventory, history, correctiveFeedback: feedback });

    let raw;
    try {
      raw = await callVlm({ config, systemText, userText, imagePath });
    } catch (e) {
      // Network failure / timeout / llama-server down. Distinct from a
      // malformed-but-present response - don't inject a "not valid JSON"
      // correction (misleading), just retry with the same feedback as
      // before; if every attempt fails this way the caller sees errorKind
      // "vlm_error" and can surface the real cause instead of a generic one.
      lastNetworkError = e;
      continue;
    }
    lastNetworkError = null;
    lastRaw = raw;

    const parsed = parseModelJson(raw);
    if (!parsed) {
      feedback = "Your previous response was not valid JSON. Return STRICT JSON only, no markdown, no extra text.";
      continue;
    }

    const result = StepResponseSchema.safeParse(parsed);
    if (result.success) {
      return { valid: true, thought: result.data.thought, action: result.data.action, rawText: raw, attempts: attempt };
    }

    feedback =
      `Your previous response did not match the required schema: ` +
      `${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. ` +
      `Return STRICT JSON only, matching the schema exactly.`;
  }

  return {
    valid: false,
    thought: null,
    action: null,
    rawText: lastRaw,
    attempts: 3,
    errorKind: lastNetworkError ? "vlm_error" : "invalid_json",
    errorMessage: lastNetworkError ? lastNetworkError.message : null,
  };
}

export const _internal = { formatInventoryForPrompt, formatHistoryLine, extractLastJsonObject, buildPrompt };

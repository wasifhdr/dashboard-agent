import fs from "node:fs";
import sharp from "sharp";
import { StepResponseSchema } from "./actionSchema.js";
import { normalizeDiscoveryText } from "./discoveries.js";

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
  if (h.type === "scroll") return `${h.direction} (${h.nx?.toFixed(2)},${h.ny?.toFixed(2)})`;
  if (h.type === "click") return `(${h.nx?.toFixed(2)},${h.ny?.toFixed(2)})`;
  if (h.values !== undefined) return `${h.target_id}=${JSON.stringify(h.values)}`;
  if (h.value !== undefined) return `${h.target_id}=${JSON.stringify(h.value)}`;
  if (h.min !== undefined || h.max !== undefined) return `${h.target_id}=[${h.min ?? "?"}..${h.max ?? "?"}]`;
  if (h.target_id) return h.target_id;
  return "";
}

// For a click or a scroll, the model cares whether it worked, not the internal
// step status — so an executed ("ok") one reports "changed" / "no change".
// Rejected/errored ones keep their status so the model sees they didn't run.
function clickOutcome(h) {
  if (h.status === "ok") return h.changed ? "changed" : "no change";
  return h.status;
}

function formatHistoryLine(h) {
  const detail = describeActionForHistory(h);
  // Scroll shares the click reporting: "ok" tells the model nothing useful about
  // a scroll, since a wheel that hit an already-bottomed pane also succeeds.
  const outcome = h.type === "click" || h.type === "scroll" ? clickOutcome(h) : h.status;
  return `#${h.idx} ${h.type}${detail ? " " + detail : ""} -> ${outcome}`;
}

const SYSTEM_TEMPLATE = (question) => `You are an agent that answers a question about a live, interactive Tableau dashboard by operating its filters, parameters, and tabs, then answering.

QUESTION: "${question}"

On each turn you are shown:
- The current dashboard screenshot
- An inventory of the controls you can operate, each with a stable id (e.g. F1, P2, S1)
- A short history of your previous actions and their outcomes
- CONFIRMED DISCOVERIES: hard facts you recorded on earlier steps of this session

Respond with STRICT JSON ONLY (no markdown, no extra commentary, no text outside the JSON object), matching exactly this shape:
{"discovery": "<hard data visible in this screenshot, or null>", "thought": "<= 2 sentences explaining your reasoning", "action": { ... }}

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
3. Prefer "answer" as soon as CONFIRMED DISCOVERIES plus the current screenshot contain everything needed - do not take extra actions once you already have enough information.
4. Never repeat an action you have already performed successfully - check the history below first; repeating is rejected and wastes a turn.
5. Only use "wait" if the dashboard visibly appears to still be loading or updating; never use it more than twice in a row.
6. Only use "fail" if the question is genuinely unanswerable from this dashboard after exploring it.
7. set_filter is for categorical filters only; set_range_filter is for range (numeric/date) filters only - check each filter's "type" in the inventory.

RECORDING DISCOVERIES:
"discovery" records hard data visible in the CURRENT screenshot that you will need later.
- Numbers, names, labels, textual facts. Max 15 words.
- ALWAYS name what the value belongs to. Write "House avg beds = 3.3", never "avg beds = 3.3".
- Record NOTHING about the UI: not what is open or closed, not where a control is, not what you clicked.
- If this screenshot shows no new hard data, use null.
Discoveries persist for the WHOLE SESSION, including across follow-up questions, and are shown back to you every step under CONFIRMED DISCOVERIES. Never take an action to re-read a value that is already listed there.`;

const PIXEL_SYSTEM_TEMPLATE = (question) => `You are an agent that answers a question about a live, interactive Tableau dashboard by OPERATING IT WITH MOUSE CLICKS, then answering.

QUESTION: "${question}"

On each turn you are shown:
- The current dashboard screenshot
- An inventory of the controls that exist (for reference — it tells you WHAT is there, but you must act by CLICKING, not by id)
- A short history of your previous actions and their outcomes
- CONFIRMED DISCOVERIES: hard facts you recorded on earlier steps of this session

You interact ONLY by clicking. Emit a click as normalized fractions of the image: nx is the horizontal fraction (0 = left edge, 1 = right edge), ny is the vertical fraction (0 = top edge, 1 = bottom edge). Aim at the CENTER of the control you want.

nx and ny are DECIMAL FRACTIONS between 0 and 1 — never percentages, never pixels. Write 3 decimals. Mind the magnitude: a control tucked against the top edge is at ny ≈ 0.04, NOT 0.4 (0.4 is nearly halfway down the image); a row 5% from the left is nx ≈ 0.05, not 5 or 50.

Estimate that center as accurately as you can. Your point is then checked by zooming into a SMALL window around it: if the thing you named in "target" is found inside that window, your click is snapped to its exact center; if it is NOT found there, the click is REJECTED and you must aim again. A point that is far from the target cannot be rescued, so read the image carefully before answering.

"target" must name the exact element you are clicking — the specific row, bar, tab or button (e.g. "the 'TV Show' row in the open Type list"), never a general area or the parent control.

Respond with STRICT JSON ONLY (no markdown, no commentary), matching exactly:
{"discovery": "<hard data visible in this screenshot, or null>", "thought": "<= 2 sentences", "action": { ... }}

The "action" object must be exactly one of:
- {"type":"click","nx":0.42,"ny":0.13,"target":"ZRI tab"}
- {"type":"scroll","nx":0.83,"ny":0.49,"direction":"down","target":"the Remote Ratio pie stack"}
- {"type":"scroll","nx":0.14,"ny":0.35,"direction":"up","target":"the open country dropdown list"}
- {"type":"wait"}
- {"type":"answer","answer":"<final answer text>","confidence":0.8}
- {"type":"fail","reason":"<why this cannot be answered>"}

Rules:
1. Exactly one action per turn.
2. To operate a control that opens (a dropdown, a filter list), click it once, then WAIT for the next screenshot and click the value you want.
3. Prefer "answer" as soon as CONFIRMED DISCOVERIES plus the screenshot show everything needed.
4. If a click produces no visible change, you missed the control or it is not on screen — NEVER repeat the same or a nearby click. Move to a clearly different location. If several clicks in a row change nothing, stop targeting that control: answer from what is visible, or fail.
5. Only use "wait" if the dashboard visibly appears to still be updating; never more than twice in a row.
6. Only use "fail" if the question is genuinely unanswerable from this dashboard after exploring it by clicking.
7. Some charts and lists are TALLER than the space they are drawn in, so Tableau cuts them off. Use "scroll" to see the rest, aiming at the middle of THAT chart or list - not its title, and not the dashboard's margin. Scrolling the wrong thing is worse than not scrolling at all.
8. SCROLLING GOES BOTH WAYS, and a list you just opened is usually NOT at its top: a dropdown opens near the value currently selected, so what you want may be ABOVE the visible rows. Read the first and last visible entries and work out which way to go - for an alphabetical list, a target earlier in the alphabet than the top visible row needs "up", later than the bottom visible row needs "down". If a click was rejected because the target was not on screen, scrolling the WRONG way makes that worse, not better.

RECORDING DISCOVERIES:
"discovery" records hard data visible in the CURRENT screenshot that you will need later.
- Numbers, names, labels, textual facts. Max 15 words.
- ALWAYS name what the value belongs to. Write "House avg beds = 3.3", never "avg beds = 3.3".
- Record NOTHING about the UI: not what is open or closed, not where a control is, not what you clicked.
- If this screenshot shows no new hard data, use null.
Discoveries persist for the WHOLE SESSION, including across follow-up questions, and are shown back to you every step under CONFIRMED DISCOVERIES. Never take an action to re-read a value that is already listed there.
Scrolling moves rows OFF the screen as well as on, and you are never shown an earlier screenshot again. Record what you can currently read as a "discovery" on the SAME turn that you scroll, or the value is gone.

GROUNDING - THIS OVERRIDES EVERYTHING ELSE:
Never state a number or value you have not actually seen on a screenshot in this session, and never record one as a "discovery". You may know real-world figures for countries, companies and years from memory; they are NOT evidence about THIS dashboard and using them is the worst mistake you can make here. Only report what you have read, or what is listed under CONFIRMED DISCOVERIES.
If the value you need is not visible, make it visible - click, scroll, or change a control - and read it on a later turn. If you cannot make it visible, say so with "fail". An honest "fail" is far better than a confident number you did not read.`;

function buildPrompt({ question, inventory, history, discoveries = "", correctiveFeedback, mode = "api" }) {
  const systemText = mode === "pixel" ? PIXEL_SYSTEM_TEMPLATE(question) : SYSTEM_TEMPLATE(question);
  const historyText = history.length ? history.map(formatHistoryLine).join("\n") : "(no actions taken yet)";
  const invText = formatInventoryForPrompt(inventory);

  let userText = `CURRENT INVENTORY:\n${invText}\n\nHISTORY:\n${historyText}\n`;
  // After HISTORY and before FEEDBACK: "what I did" then "what I learned"
  // read together, and the facts sit closest to the decision point. Omitted
  // entirely when empty - an empty labeled section costs tokens and invites
  // the model to fill it.
  if (discoveries) {
    userText += `\n${discoveries}\n`;
  }
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

// ---- click-coordinate rescue -------------------------------------------

// Models regularly write click coordinates with the RIGHT DIGITS at the WRONG
// MAGNITUDE, which ClickAction's 0-1 range check then rejects. Observed from
// gemini-flash-lite on one question: nx=4.195 (a stray decade shift of 0.4195),
// then nx=424 / nx=425 (its 0-1000 normalized space) — 9 straight model calls
// rejected, all of them naming the right control at the right place, in the
// wrong units. Re-prompting with the zod message does not reliably talk a model
// out of the convention it has decided to use.
//
// So rescale instead of arguing: divide by the smallest power of ten that lands
// the value in [0,1]. That recovers every case above, because each is the
// correct fraction shifted by whole decades — percentages (42), 0-1000
// normalized space (424) and decade slips (4.195) all collapse to the same fix.
// Past 1000 no normalized convention applies and the number can only be real
// pixels, so those are divided by the frame's own dimension instead.
//
// Guessing wrong is not dangerous. A rescued click is still only an aim: pixel
// mode runs every click through refineClickPoint, which rejects it outright if
// the named target isn't in the zoom window around the point.
function decadeScale(v) {
  // Smallest power of ten that lands v in [0,1]. Normally stops at 1000; a pixel
  // value with no frame dimension to divide by (metadata read failed) needs
  // another decade or two rather than being left out of range. Bounded so it
  // always terminates.
  let scale = 10;
  while (v / scale > 1 && scale < 1e6) scale *= 10;
  return scale;
}

// The two coordinates are rescaled TOGETHER, not independently, because the
// pair's scale is a property of the space the model was writing in:
//
//   (424, 62)     both out of range, so both are in that space. The scale has to
//                 come from the pair — 424 fixes it at 0-1000, making this
//                 (0.424, 0.062). Scaling 62 on its own would read it as a
//                 percentage and put the aim at 0.62, most of the way DOWN a
//                 frame whose target sits near the top edge.
//   (4.195, 0.08) only nx is out of range, so ny is already a fraction and must
//                 be left alone; the offender is rescaled by itself.
//
// Above 1000 no normalized convention applies and the numbers can only be real
// pixels — there each axis divides by its own dimension, since width ≠ height.
function rescalePair(nx, ny, dims) {
  if (nx <= 1 && ny <= 1) return { nx, ny };

  const peak = Math.max(nx, ny);
  if (peak > 1000 && dims.width > 0 && dims.height > 0) {
    return { nx: nx > 1 ? nx / dims.width : nx, ny: ny > 1 ? ny / dims.height : ny };
  }
  if (nx > 1 && ny > 1) {
    const scale = decadeScale(peak);
    return { nx: nx / scale, ny: ny / scale };
  }
  return {
    nx: nx > 1 ? nx / decadeScale(nx) : nx,
    ny: ny > 1 ? ny / decadeScale(ny) : ny,
  };
}

// Returns `action` unchanged unless it is a click whose coordinates needed
// rescaling, in which case a corrected copy is returned.
// Covers "scroll" as well as "click": both address the frame in the same
// normalized [0,1] space, so both are subject to the same magnitude slips.
function normalizeClickAction(action, dims) {
  if (!action || (action.type !== "click" && action.type !== "scroll")) return action;
  const nx = Number(action.nx);
  const ny = Number(action.ny);
  // Non-numeric / missing coords aren't a magnitude problem — leave them for
  // zod so the model gets the accurate "expected number" complaint. Negatives
  // likewise: there is no scale that makes them a valid aim.
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || ny < 0) return action;
  if (nx <= 1 && ny <= 1) return action;
  return { ...action, ...rescalePair(nx, ny, dims) };
}

// ---- image handling ---------------------------------------------------

async function resizeImageToDataUrl(imagePath, longSide) {
  const buf = await sharp(imagePath)
    .resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// --- provider target resolution -------------------------------------------

// Returns the completions URL, model name, and API-key env-var NAME for the
// configured VLM. There is exactly one supported shape now: a hosted
// OpenAI-compatible endpoint under config.pixel. The local llama-server path
// was removed with the local model, so an unconfigured endpoint is a hard
// error rather than a silent fallback to a URL nothing is listening on.
//
// This is deliberately independent of actuationMode - the mode selects which
// system prompt is built, not where the request goes.
function resolveVlmTarget(config) {
  const endpoint = config.pixel?.vlmEndpoint;
  if (!endpoint) {
    throw new Error(
      "No VLM endpoint configured: set config.pixel.vlmEndpoint (plus pixel.modelName and " +
        "pixel.vlmApiKeyEnv). The local llama-server path has been removed.",
    );
  }
  return {
    url: `${endpoint}/v1/chat/completions`,
    modelName: config.pixel.modelName ?? null,
    apiKeyEnv: config.pixel.vlmApiKeyEnv ?? null,
  };
}

// The model actually answering, for recording alongside a session. Kept
// separate from resolveVlmTarget because a bookkeeping read must never throw
// on a half-configured install.
export function activeModelName(config) {
  return config.pixel?.modelName ?? null;
}

// Builds the Authorization header from an env-var NAME (never a literal key).
// Empty/absent env value -> no header (local mode, or a misconfigured key).
function authHeaders(apiKeyEnv, env) {
  const value = apiKeyEnv ? env[apiKeyEnv] : null;
  return value ? { Authorization: `Bearer ${value}` } : {};
}

// ---- VLM call -----------------------------------------------------------

async function callVlm({ config, systemText, userText, imagePath, imageDataUrl: preparedImage, stopSignal }) {
  // `preparedImage` lets a caller supply its own already-encoded image (the
  // zoom-refine pass sends an UPSCALED crop, which resizeImageToDataUrl's
  // withoutEnlargement would refuse to produce).
  const imageDataUrl = preparedImage ?? (await resizeImageToDataUrl(imagePath, config.imageLongSide));
  const target = resolveVlmTarget(config);

  const payload = {
    model: target.modelName,
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

  for (let attempt = 0; ; attempt++) {
    // The timeout is scoped to ONE attempt, not to the whole call. Sharing it
    // across retries meant a long rate-limit wait ate the request's own budget
    // and the step died as "This operation was aborted" - an opaque message for
    // what is really "we were throttled", and a request that never got its
    // configured time to answer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.vlmCallTimeoutMs);
    // Abort the in-flight request on EITHER the per-call timeout OR an external
    // stop request (the user hitting Stop), so a stop takes effect immediately
    // instead of waiting for this (slow, in pixel mode) call to finish.
    const fetchSignal = stopSignal ? AbortSignal.any([controller.signal, stopSignal]) : controller.signal;

    let res;
    let bodyText;
    try {
      res = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(target.apiKeyEnv, process.env) },
        body: JSON.stringify(payload),
        signal: fetchSignal,
      });
      bodyText = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const json = JSON.parse(bodyText);
      return json?.choices?.[0]?.message?.content ?? "";
    }

    // A rate limit is a "come back shortly", not a failure of the run, and
    // treating it as one loses whole sessions: three of these in a row is an
    // invalid-response streak, which aborts the session with a quota message
    // where the trajectory should be. It is easy to hit because a pixel step
    // costs two calls (action + zoom check, sometimes a third to locate), so
    // eight steps clears a 15-per-minute allowance inside half a minute.
    if (!isRetryableStatus(res.status)) {
      throw new Error(`VLM endpoint error ${res.status}: ${bodyText.slice(0, 800)}`);
    }
    if (attempt >= RATE_LIMIT_RETRIES) {
      // Say WHY up front. Left as the bare status line, a quota wall reads like
      // a code bug in the step list and sends you looking through the prompt
      // for a fault that is really just a spent free tier.
      throw new Error(
        `VLM endpoint error ${res.status}: rate limited, still throttled after ${RATE_LIMIT_RETRIES} retries - ` +
          `the API quota is spent, not the agent's logic. ${bodyText.slice(0, 600)}`,
      );
    }
    // Only Stop interrupts a backoff wait; the per-attempt timeout above has
    // already been cleared, so waiting out a quota window cannot consume it.
    await sleepAbortable(retryDelayMs(bodyText, attempt), stopSignal);
  }
}

// 429 = quota/rate limit, 503 = model briefly overloaded. Both clear on their
// own; every other non-2xx is a real error and must surface immediately.
const RATE_LIMIT_RETRIES = 3;
function isRetryableStatus(status) {
  return status === 429 || status === 503;
}

// Gemini's 429 body states how long to wait ("Please retry in 8.363871091s"),
// which beats guessing - the whole point of the free tier's window is that it
// reopens at a known moment. Falls back to a widening backoff when the body
// says nothing useful. The +250ms guards against waking a hair too early and
// spending the retry on the same closed window.
function retryDelayMs(bodyText, attempt) {
  const m = /retry in ([\d.]+)s/i.exec(bodyText || "");
  const hinted = m ? Number(m[1]) * 1000 + 250 : NaN;
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 60_000);
  return Math.min(2_000 * 2 ** attempt, 30_000);
}

// The per-call timeout and the user's Stop both abort through `signal`, so a
// wait between retries has to end with them - otherwise Stop appears to hang
// for the length of a rate-limit window.
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(signal.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- public: zoom-refine a click point -----------------------------------

// Fraction of the full frame shown in the zoom crop. 0.22 turns a dropdown row
// (~2.6% of the frame's height) into ~12% of the crop's height — comfortably
// inside the model's spatial accuracy, while still showing enough surrounding
// context to tell neighbouring rows apart.
const REFINE_WINDOW = 0.22;
// Long side the crop is upscaled to before sending. Independent of
// config.imageLongSide: this is a small region, and upscaling is the point.
const REFINE_LONG_SIDE = 1024;
// Crop window for locate's cell-repair pass: one cell of the 3x3 grid (0.333)
// plus a small margin, so a target sitting hard against a cell boundary is still
// inside the crop. Anything much larger reintroduces the whole-frame coordinate
// range this pass exists to escape.
const CELL_WINDOW = 0.36;

// Deliberately NOT phrased as "the crop is centered on the target, find it".
// That wording presupposed the answer, and this model obliges a presupposition:
// handed a crop around a middle-of-frame aim while the real control sat in the
// top-left corner, it returned a confident {"found": true} pointing at whatever
// happened to be in the crop. Because refine leads the click path, that false
// positive short-circuits locate - the ONLY pass that can reach a target more
// than ~11% of the frame away - and the agent clicks a chart mark instead of the
// control it named. Observed on the Netflix dashboard 2026-08-16, where it hit
// the "Movie" bubble (tooltip + Keep Only/Exclude menu) three steps running.
//
// So the crop is described for what it is - a blind cut around an unverified
// guess - and "not here" is presented as the expected answer rather than a
// failure. The `match` field is the other half: a model that must quote the text
// it matched on cannot bluff its way past a bubble chart nearly as easily as one
// answering a bare {"found": true}.
const REFINE_SYSTEM = (target) => `You are checking whether a UI agent's intended click target is inside this crop, and if it is, exactly where.

The image is a ZOOMED-IN CROP of a Tableau dashboard, cut blind around an UNVERIFIED guess at where${target ? ` "${target}"` : " the target"} might be. The crop covers only about a fifth of the dashboard's width and height, and the guess is often wrong by much more than that, so the target is FREQUENTLY NOT IN THIS CROP AT ALL.

Saying it is not here is a correct and useful answer, not a failure: a search of the whole dashboard runs next and will find it. Do not assume the target is present just because it is named. Look first, then answer.

If you can actually SEE it in this crop, respond with STRICT JSON ONLY:
{"found": true, "match": "<the exact visible text, or the unmistakable feature, you matched on>", "nx": 0.51, "ny": 0.34}

nx is the horizontal fraction of the CROP (0 = its left edge, 1 = its right edge) and ny is the vertical fraction (0 = top edge, 1 = bottom edge), giving the CENTER of the target. "match" must quote text you can genuinely read in this image or name an unmistakable visual feature of the element; if you cannot fill it in honestly, the target is not here.

If it is not in this crop - including when only something vaguely similar is here - respond exactly:
{"found": false}

Be precise: rows in an open dropdown list are thin, so aim at the vertical middle of the intended row, not the boundary between rows.`;

// Pure reading of a refine reply, split out so the evidence gate is testable
// without sharp, the network, or a model. Coordinates come back CROP-relative;
// the caller maps them into the full frame.
//
// Returns {nx, ny, match} | {notFound: true} | null, matching refineClickPoint's
// contract - notFound is a verdict about this crop, null means "no usable
// answer", and both escalate to locate.
export function interpretRefineResponse(parsed, cropDims) {
  if (!parsed) return null;
  if (parsed.found === false) return { notFound: true };

  // No evidence, no find. A reply that claims the target without being able to
  // name what it saw is exactly the bluff this pass exists to stop, and it is
  // reported as notFound rather than null so it ESCALATES to the whole-frame
  // search instead of silently keeping the unrefined aim.
  //
  // Cost note: a compliant model fills this in, so the common path is still one
  // verification call. When it doesn't, the extra locate call is the right thing
  // to spend - an unverified refine is how the wrong element gets clicked.
  const match = typeof parsed.match === "string" ? parsed.match.trim() : "";
  if (!match) return { notFound: true };

  // Same magnitude rescue as the main loop — a refine answer in pixels or
  // 0-1000 space is a real verdict about where the target is, and dropping it
  // to null would silently fall back to the unrefined coarse aim.
  const pnx = Number(parsed.nx);
  const pny = Number(parsed.ny);
  if (!Number.isFinite(pnx) || !Number.isFinite(pny) || pnx < 0 || pny < 0) return null;
  const { nx, ny } = rescalePair(pnx, pny, cropDims);
  if (nx > 1 || ny > 1) return null;
  return { nx, ny, match };
}

// Second pass over a click point: crop a window around the model's coarse aim,
// upscale it, and ask the model to place the point again within that crop. The
// refined point is mapped back into full-frame coordinates.
//
// Returns one of:
//   {nx, ny, match}   - refined point, in full-frame coordinates. `match` is the
//                       text or feature the model says it matched on: the
//                       evidence that makes the find checkable rather than a
//                       bare assertion. A reply without it is not a find.
//   {notFound: true}  - the model looked and the named target is NOT in the
//                       window, i.e. the aim is wrong by more than the window.
//                       The caller rejects the click instead of firing it at a
//                       place the target demonstrably isn't (that is what let a
//                       0.81 aim at a row sitting at 0.087 keep executing, each
//                       stray click dismissing the dropdown the previous step
//                       had opened).
//   null              - refinement itself failed (crop error, bad JSON, network,
//                       stop). Degrades to the previous single-pass behavior:
//                       the caller keeps the coarse point. A refine outage must
//                       never block clicking.
export async function refineClickPoint({ config, imagePath, nx, ny, target, stopSignal, window = REFINE_WINDOW }) {
  try {
    const meta = await sharp(imagePath).metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) return null;

    // Crop window, clamped to stay inside the frame (the clamp shifts the
    // window rather than shrinking it, so the mapping back stays uniform).
    // `window` is overridable for one caller only: the locate repair pass crops a
    // whole 3x3 CELL (a third of the frame) rather than a control-sized patch,
    // because the point it is given is a cell centre and the target can be
    // anywhere in that cell - including its far corner, which a 22% window
    // centred on the cell would miss.
    const cw = Math.max(1, Math.round(W * window));
    const ch = Math.max(1, Math.round(H * window));
    const left = Math.min(Math.max(0, Math.round(nx * W - cw / 2)), W - cw);
    const top = Math.min(Math.max(0, Math.round(ny * H - ch / 2)), H - ch);

    // resolveWithObject so the crop's SENT dimensions are known — the refine
    // model is the same one that misscales coordinates in the main loop, and
    // rescuing its answer needs the size of the image it was looking at.
    const { data: buf, info } = await sharp(imagePath)
      .extract({ left, top, width: cw, height: ch })
      .resize({ width: REFINE_LONG_SIDE, height: REFINE_LONG_SIDE, fit: "inside" })
      .png()
      .toBuffer({ resolveWithObject: true });

    const raw = await callVlm({
      config,
      systemText: REFINE_SYSTEM(target),
      userText: "Return the JSON object now.",
      imageDataUrl: `data:image/png;base64,${buf.toString("base64")}`,
      stopSignal,
    });

    // An explicit "not here" - and an unevidenced "found" - are verdicts about
    // this crop, not failures; both escalate to the whole-frame search.
    const read = interpretRefineResponse(extractLastJsonObject(raw), {
      width: info.width,
      height: info.height,
    });
    if (!read || read.notFound) return read;

    return {
      nx: (left + read.nx * cw) / W,
      ny: (top + read.ny * ch) / H,
      match: read.match,
    };
  } catch {
    // Never let refinement break a step - the caller falls back to the
    // original point (including when the user hits Stop mid-refine).
    return null;
  }
}

// ---- public: locate a named target in the WHOLE frame ---------------------

// Two-stage, and the first stage is the one worth having. Measured on committed
// Netflix frames, 6 samples per cell (scratchpad A/B, 2026-08-17): asked for a
// corner control, the flat "just give me nx,ny" prompt below-left scored 0/12
// across two corner targets, every answer landing mid-frame. Asked to name the
// 3x3 cell FIRST, the model named "left/top" 12/12 - it knows perfectly well
// where the control is - and then contradicted its own classification with a
// mid-frame decimal in 7 of those 12. Anchoring alone lifted coordinate accuracy
// to 5/12; the rest of the win comes from `cellConsistency` below acting on the
// disagreement, because the CLASSIFICATION is the trustworthy output and the
// decimals are not. A mid-frame control scored 6/6 either way, so the anchoring
// costs nothing on the easy case.
const LOCATE_SYSTEM = (target) => `You are helping a UI agent that aimed a click in the wrong place.

The image is a FULL screenshot of a Tableau dashboard. Find this element: "${target}".

Answer in TWO STAGES. Do not skip stage 1, and do not revise it once written.

STAGE 1 - which CELL. Mentally divide the image into a 3x3 grid and name the cell the element sits in:
  "col": "left" | "center" | "right"
  "row": "top" | "middle" | "bottom"

STAGE 2 - where in that cell. Now give nx (horizontal fraction of the WHOLE image, 0 = left edge, 1 = right edge) and ny (vertical fraction, 0 = top edge, 1 = bottom edge) for the element's CENTER. These MUST fall inside the cell you just named:
  col left -> nx below 0.33   center -> nx 0.33 to 0.67   right -> nx above 0.67
  row top -> ny below 0.33    middle -> ny 0.33 to 0.67   bottom -> ny above 0.67

Write the fields in that order. An element tucked into the top-left cell is around (0.05, 0.04) - three decimals, never a percentage, never pixels.

Respond with STRICT JSON ONLY, matching exactly:
{"found": true, "col": "left", "row": "top", "nx": 0.051, "ny": 0.043}

If that element is genuinely not visible anywhere in this screenshot, respond exactly:
{"found": false}`;

const COLS = ["left", "center", "right"];
const ROWS = ["top", "middle", "bottom"];

// Which third a fraction falls in. The BAND_SLOP margin exists because the
// measurement found a real boundary artifact: for a bubble whose true centre is
// ny=0.405 - a whisker past the 0.333 line - the model answered "top" with an
// excellent 0.395, and a strict comparison would have called that a
// contradiction and spent a repair call fixing nothing. Anything within the
// margin of a boundary counts as agreeing with either neighbour. 0.08 rather
// than a rounder 0.05 because the measured case needs it: the bubble's true
// centre is 0.405 and the model answered 0.395, which is 0.062 past the 0.333
// line. Still well under half a cell (0.167), so the mid-frame answers this
// check exists to catch - 0.44 and up under a "top" classification - are caught.
const BAND_SLOP = 0.08;
function bandsFor(v, names) {
  const out = [];
  if (v < 1 / 3 + BAND_SLOP) out.push(names[0]);
  if (v > 1 / 3 - BAND_SLOP && v < 2 / 3 + BAND_SLOP) out.push(names[1]);
  if (v > 2 / 3 - BAND_SLOP) out.push(names[2]);
  return out;
}

// Centre of a named cell, in frame fractions. Used as the point to re-crop
// around when the model's decimals contradict its own classification.
export function cellCenter(col, row) {
  const ci = COLS.indexOf(col);
  const ri = ROWS.indexOf(row);
  if (ci < 0 || ri < 0) return null;
  return { nx: ci / 3 + 1 / 6, ny: ri / 3 + 1 / 6 };
}

// Do the decimals land in the cell the model named? Returns null when it named
// no cell (an older/degraded reply), which the caller treats as "nothing to
// check" rather than as a contradiction.
export function cellConsistency(parsed, nx, ny) {
  const col = typeof parsed?.col === "string" ? parsed.col.trim().toLowerCase() : null;
  const row = typeof parsed?.row === "string" ? parsed.row.trim().toLowerCase() : null;
  if (!COLS.includes(col) || !ROWS.includes(row)) return null;
  return {
    col,
    row,
    agrees: bandsFor(nx, COLS).includes(col) && bandsFor(ny, ROWS).includes(row),
  };
}

// Whole-frame search for a named element, used when refineClickPoint reports
// the target isn't anywhere near the model's aim.
//
// This exists because a rejection alone could not break a wrong-coordinate
// loop: told only "your coordinates are wrong, look again", gemini-flash-lite
// re-emitted the same center-of-image point (0.68,0.46) for a control sitting
// at (0.07,0.04) across eight straight steps, naming the right control in its
// thought every time. The failure is coordinate regression, not perception, so
// the fix has to ASK for the coordinate rather than ask the model to try again.
//
// One narrow question about one element beats the main loop's prompt at this:
// no inventory, no history, no action schema, nothing to decide - just "where
// is X". Costs no extra requests in the rejection path, because it replaces the
// step that would otherwise have been spent re-guessing.
//
// Returns {nx, ny} | {notFound: true} | null (same contract as refineClickPoint).
export async function locateTarget({ config, imagePath, target, stopSignal }) {
  if (!target) return null;
  try {
    const meta = await sharp(imagePath).metadata();
    const raw = await callVlm({
      config,
      systemText: LOCATE_SYSTEM(target),
      userText: "Return the JSON object now.",
      imagePath,
      stopSignal,
    });
    const parsed = extractLastJsonObject(raw);
    if (!parsed) return null;
    if (parsed.found === false) return { notFound: true };
    const pnx = Number(parsed.nx);
    const pny = Number(parsed.ny);
    if (!Number.isFinite(pnx) || !Number.isFinite(pny) || pnx < 0 || pny < 0) return null;
    // Same magnitude rescue as everywhere else - this model writes percentages
    // and 0-1000 space as readily as fractions, and the answer is a real verdict
    // about where the element is.
    const { nx, ny } = rescalePair(pnx, pny, { width: meta.width ?? 0, height: meta.height ?? 0 });
    if (nx > 1 || ny > 1) return null;

    // Stage 1 vs stage 2. When the model names a cell and then writes decimals
    // that sit somewhere else, believe the CELL: measured 12/12 correct on the
    // corner targets where the decimals were right only 5/12. Re-ask inside that
    // cell alone, where the coordinate range is a third as wide and the crop is
    // magnified - the same trick refine already wins with, aimed by the one
    // output of this call that can be trusted.
    const cell = cellConsistency(parsed, nx, ny);
    if (cell && !cell.agrees) {
      const centre = cellCenter(cell.col, cell.row);
      const repaired = await refineClickPoint({
        config,
        imagePath,
        nx: centre.nx,
        ny: centre.ny,
        target,
        stopSignal,
        window: CELL_WINDOW,
      });
      if (repaired && !repaired.notFound) return { nx: repaired.nx, ny: repaired.ny, repaired: true };
      // The re-ask found nothing it could name. The cell centre is still a better
      // point than a decimal the model itself just contradicted - and it lands
      // the click inside the right third rather than halfway across the frame.
      return { nx: centre.nx, ny: centre.ny, repaired: true, coarse: true };
    }
    return { nx, ny };
  } catch {
    // Never let the locate pass break a step - the caller falls back to
    // rejecting the click, which is the behavior it had before this existed.
    return null;
  }
}

// ---- public: get the next validated action, with a bounded re-prompt policy

// Up to 3 total attempts (1 initial + 2 re-prompts) before giving up
// (AGENT_PLAN.md 6.2: "up to 2 re-prompts... a 3rd failure records the step
// as invalid_json").
export async function getNextAction({ config, question, inventory, history, discoveries = "", imagePath, correctiveFeedback, onAttempt = () => {}, stopSignal }) {
  let feedback = correctiveFeedback;
  let lastRaw = null;
  let lastNetworkError = null;

  // Frame dimensions, probed at most once and only if a click actually needs
  // rescaling. The resize callVlm applies is fit:"inside", so it preserves
  // aspect ratio — a pixel/dimension fraction is identical whether measured on
  // the original screenshot or the resized copy the model saw.
  let dims = null;
  async function frameDims() {
    if (!dims) {
      try {
        const meta = await sharp(imagePath).metadata();
        dims = { width: meta.width ?? 0, height: meta.height ?? 0 };
      } catch {
        dims = { width: 0, height: 0 }; // rescaleCoord falls back to decades
      }
    }
    return dims;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    // A stop requested mid-flight aborts callVlm below; don't burn the
    // remaining retries re-issuing (immediately-aborting) calls — bail out so
    // the orchestrator's post-call shouldStop() check ends the run promptly.
    if (stopSignal?.aborted) break;
    if (attempt >= 2) onAttempt(attempt);
    const { systemText, userText } = buildPrompt({ question, inventory, history, discoveries, correctiveFeedback: feedback, mode: config.actuationMode ?? "pixel" });

    let raw;
    try {
      raw = await callVlm({ config, systemText, userText, imagePath, stopSignal });
    } catch (e) {
      // Network failure / timeout / VLM endpoint down. Distinct from a
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

    // Rescue right-digits/wrong-magnitude coordinates before validating, so a
    // usable aim isn't thrown away over its units (see normalizeClickAction).
    // BOTH pixel-space action types must be listed here, not just in the
    // function: this guard is what decides whether it is ever called.
    if (parsed?.action?.type === "click" || parsed?.action?.type === "scroll") {
      parsed.action = normalizeClickAction(parsed.action, await frameDims());
    }

    // Normalized BEFORE validation, so a model that writes "None", echoes the
    // field label, or returns a number can never fail the schema over it.
    if (parsed && typeof parsed === "object") {
      parsed.discovery = normalizeDiscoveryText(parsed.discovery);
    }

    const result = StepResponseSchema.safeParse(parsed);
    // Both click and scroll are pixel-mode only; api mode must reject either.
    const isPixelOnlyAction =
      result.success && (result.data.action.type === "click" || result.data.action.type === "scroll");
    if (result.success && !((config.actuationMode ?? "pixel") !== "pixel" && isPixelOnlyAction)) {
      return {
        valid: true,
        discovery: result.data.discovery ?? null,
        thought: result.data.thought,
        action: result.data.action,
        rawText: raw,
        attempts: attempt,
      };
    }

    feedback = result.success
      ? `The "click" and "scroll" actions are not available in this mode. Use one of the provided action types.`
      : `Your previous response did not match the required schema: ` +
        `${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. ` +
        `Return STRICT JSON only, matching the schema exactly.`;
  }

  return {
    valid: false,
    discovery: null,
    thought: null,
    action: null,
    rawText: lastRaw,
    attempts: 3,
    errorKind: lastNetworkError ? "vlm_error" : "invalid_json",
    errorMessage: lastNetworkError ? lastNetworkError.message : null,
  };
}

export const _internal = {
  // Exposed so a prompt A/B can drive an arbitrary system prompt against a real
  // frame without going through an agent run - the only cheap way to measure a
  // grounding change, since a full run costs ~15 requests and confounds the
  // prompt with the loop guards.
  callVlm,
  formatInventoryForPrompt,
  formatHistoryLine,
  extractLastJsonObject,
  buildPrompt,
  resolveVlmTarget,
  authHeaders,
  rescalePair,
  normalizeClickAction,
  isRetryableStatus,
  retryDelayMs,
};

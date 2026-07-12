// The agent loop: perceive -> inventory -> prompt -> validate -> execute ->
// settle -> persist (AGENT_PLAN.md Phase 1). Question in, trajectory + answer
// out. onEvent is a plain callback so the same loop can drive both a CLI
// (now) and an SSE stream (Phase 2) without change.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FRAMES_DIR } from "./paths.js";
import { openSession, waitForSettle, screenshotViz, computeChangedRegions } from "./perception.js";
import { createInventoryTracker } from "./inventory.js";
import { getNextAction } from "./vlmClient.js";
import { executeActionWithTimeout, describeAction } from "./actuator.js";
import * as store from "./store.js";

function actionKey(action) {
  switch (action.type) {
    case "set_filter":
      return `set_filter:${action.target_id}:${JSON.stringify([...action.values].sort())}`;
    case "set_range_filter":
      return `set_range_filter:${action.target_id}:${action.min ?? ""}:${action.max ?? ""}`;
    case "set_parameter":
      return `set_parameter:${action.target_id}:${action.value}`;
    case "switch_sheet":
      return `switch_sheet:${action.target_id}`;
    default:
      return `${action.type}:${action.target_id ?? ""}`;
  }
}

// Best-effort widget bounding box (AGENT_PLAN.md 6.6): search the Tableau
// iframe's DOM for text matching the field/parameter name. Frequently fails
// (Tableau renders most marks to canvas) - that's expected, never blocks.
async function findWidgetBbox(page, labelText) {
  if (!labelText) return null;
  try {
    const candidateFrames = page.frames().filter((f) => f.url().includes("tableau.com")).slice(0, 3);
    for (const frame of candidateFrames) {
      const loc = frame.getByText(labelText, { exact: false }).first();
      await loc.waitFor({ state: "attached", timeout: 1000 });
      const box = await loc.boundingBox();
      if (box) {
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
      }
    }
  } catch {
    // best-effort only
  }
  return null;
}

async function forceBestEffortAnswer({ config, question, inventory, history, framePath }) {
  const feedback =
    "You have reached the maximum number of steps. Based on everything you have seen so far, provide your " +
    'best-effort final answer NOW. You must respond with an "answer" action (or "fail" only if truly impossible).';
  const { valid, thought, action } = await getNextAction({
    config,
    question,
    inventory,
    history,
    imagePath: framePath,
    correctiveFeedback: feedback,
  });

  if (valid && (action.type === "answer" || action.type === "fail")) {
    return { thought, action };
  }
  return {
    thought: thought ?? "(no valid final response within the step budget)",
    action: { type: "fail", reason: "Model did not provide a usable answer within the step budget." },
  };
}

export async function runSession({
  browser,
  config,
  dashboardUrl,
  dashboardName,
  question,
  onEvent = () => {},
  sessionId: providedSessionId,
  shouldStop = () => false,
  // Conversation reuse opts (docs/LIVE_TAKEOVER_PLAN.md Phase B0). All
  // optional and default to today's standalone-session behavior:
  // - page: an already-open Playwright page to reuse. When provided,
  //   openSession() is skipped and this page is used directly.
  // - ownsPage: when false, the browser context is NOT closed at the end
  //   (the conversation runtime owns it instead). Defaults to true, i.e.
  //   every existing caller keeps closing its own context as today.
  // - conversationId / turnIndex: passed through to store.createSession so
  //   this session row can be attributed to a conversation + turn. Omitted
  //   (null) for standalone sessions, exactly as before this change.
  page: providedPage = null,
  ownsPage = true,
  conversationId = null,
  turnIndex = null,
}) {
  // Allows a caller (the server, for POST /api/sessions) to generate and
  // return the id synchronously before the run completes; the CLI just lets
  // one be generated here.
  // Guard the reuse-page opts' pairing (docs/LIVE_TAKEOVER_PLAN.md B0 review
  // fix): `page` and `ownsPage` must be passed together consistently, or a
  // future caller silently gets the wrong context-lifecycle behavior - a
  // provided page with ownsPage left at its true default would get its
  // context closed out from under the caller who still owns it, while
  // ownsPage:false with no page would open a context here that nobody ever
  // closes. This is a pure validation addition; every existing call site
  // (CLI: neither opt passed; server.js: always page + ownsPage:false)
  // already satisfies it, so behavior is unchanged for all current callers.
  if (providedPage && ownsPage) {
    throw new Error(
      "runSession: a `page` was provided without `ownsPage: false` - pass ownsPage:false when reusing an externally-owned page, or runSession will close a context the caller still needs.",
    );
  }
  if (!providedPage && !ownsPage) {
    throw new Error("runSession: `ownsPage: false` requires an explicit `page` - otherwise the context opened here would never be closed.");
  }

  const sessionId = providedSessionId ?? crypto.randomUUID();
  const framesDir = path.join(FRAMES_DIR, sessionId);
  fs.mkdirSync(framesDir, { recursive: true });

  store.createSession({
    id: sessionId,
    dashboard_url: dashboardUrl,
    dashboard_name: dashboardName ?? null,
    question,
    model_id: config.modelName,
    config_json: JSON.stringify(config),
    conversation_id: conversationId,
    turn_index: turnIndex,
  });
  onEvent({ type: "session_started", sessionId, dashboardUrl, question });

  const tracker = createInventoryTracker();
  const history = [];
  let invalidCount = 0;
  let consecutiveWaits = 0;
  // Tracks steps in a row that made no real progress (rejected/errored),
  // regardless of whether they were exact repeats. Used to escalate
  // corrective feedback so the model re-scans the whole inventory instead
  // of retrying variations on the same wrong target_id.
  let consecutiveNonProgress = 0;

  function withEscalation(feedback) {
    if (consecutiveNonProgress >= 2) {
      return (
        `${feedback} You have made no progress for ${consecutiveNonProgress} steps in a row. ` +
        `Stop retrying variations of the same target_id - it is likely the wrong control entirely. ` +
        `Re-read the FULL inventory below, including BOTH the FILTERS and PARAMETERS sections (a dashboard ` +
        `can have a parameter and a filter that sound similar but only one of them is actually wired to what ` +
        `you see on screen), and pick a different id.`
      );
    }
    return feedback;
  }
  let prevFramePath = null;

  function persistAndEmit({
    idx,
    thought,
    action,
    status,
    errorMsg = null,
    framePath,
    inventory,
    changedRegions,
    settleTimeout = false,
    startedAt,
    durationMs,
    actionBadge = null,
    widgetBbox = null,
  }) {
    const overlay = { action_badge: actionBadge, widget_bbox: widgetBbox, changed_regions: changedRegions };
    store.insertStep({
      session_id: sessionId,
      step_idx: idx,
      thought,
      action_json: action ? JSON.stringify(action) : null,
      action_status: status,
      error_msg: errorMsg,
      frame_raw_path: framePath,
      overlay_json: JSON.stringify(overlay),
      inventory_json: JSON.stringify(inventory),
      settle_timeout: settleTimeout ? 1 : 0,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: durationMs,
    });
    const inventorySummary = inventory
      ? {
          activeSheet: inventory.activeSheet,
          sheetCount: inventory.sheets.length,
          filterCount: inventory.filters.length,
          parameterCount: inventory.parameters.length,
        }
      : null;
    onEvent({
      type: "step",
      idx,
      thought,
      action,
      action_status: status,
      error_msg: errorMsg,
      frame: framePath,
      overlay,
      inventorySummary,
    });
  }

  let page;
  try {
    if (providedPage) {
      // Reuse mode: the conversation runtime already opened this page.
      // Still run the settle gate before the loop - the user (or the tail
      // end of the prior turn) may have left the dashboard mid-animation.
      page = providedPage;
    } else {
      const opened = await openSession(browser, config.hostPageOrigin, dashboardUrl, { firstLoadTimeoutMs: 90000 });
      page = opened.page;
    }
    await waitForSettle(page, config.settleGate);
  } catch (e) {
    const errorMessage = `Dashboard failed to load: ${e.message}`;
    store.finishSession(sessionId, { status: "error", error_message: errorMessage });
    onEvent({ type: "session_done", status: "error", final_answer: null, confidence: null, error: errorMessage });
    return { sessionId, status: "error", finalAnswer: null, confidence: null };
  }

  let idx = 0;
  let correctiveFeedback = null;
  let sessionOutcome = null;
  const sessionDeadline = Date.now() + config.sessionWallClockMs;

  while (idx < config.maxSteps) {
    if (Date.now() > sessionDeadline) {
      onEvent({ type: "warning", idx, kind: "wall_clock_timeout" });
      break;
    }

    if (shouldStop()) {
      sessionOutcome = { status: "stopped", answer: null, confidence: null };
      break;
    }

    idx++;
    const stepStartedAt = Date.now();
    onEvent({ type: "step_started", idx });

    const framePath = path.join(framesDir, `step_${idx}.png`);
    await screenshotViz(page, framePath);

    const changedRegions = prevFramePath
      ? await computeChangedRegions(prevFramePath, framePath).catch(() => [])
      : [];

    onEvent({ type: "frame_captured", idx, frame: framePath, changedRegions });

    const rawInv = await page.evaluate(() => window.__agentBridge.getInventory());
    const inv = tracker.normalize(rawInv);

    // AGENT_PLAN.md pitfall #8: some vizzes have no API-operable controls at
    // all (static, or all-canvas custom controls). Warn once, but still let
    // the agent try to answer from the initial view rather than failing hard.
    if (idx === 1) {
      const operableFilters = inv.filters.filter((f) => f.operable).length;
      if (operableFilters === 0 && inv.parameters.length === 0 && inv.sheets.length <= 1) {
        onEvent({ type: "warning", idx, kind: "empty_inventory" });
      }
    }

    const { valid, thought, action, rawText, errorKind, errorMessage } = await getNextAction({
      config,
      question,
      inventory: inv,
      history,
      imagePath: framePath,
      correctiveFeedback,
      onAttempt: (attempt) => onEvent({ type: "vlm_attempt", idx, attempt }),
    });

    if (shouldStop()) {
      sessionOutcome = { status: "stopped", answer: null, confidence: null };
      break;
    }

    correctiveFeedback = null;

    const durationMs = Date.now() - stepStartedAt;

    if (!valid) {
      invalidCount++;
      const status = errorKind === "vlm_error" ? "vlm_error" : "invalid_json";
      persistAndEmit({
        idx,
        thought: null,
        action: null,
        status,
        errorMsg: errorKind === "vlm_error" ? errorMessage : (rawText || "").slice(0, 500),
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: errorKind === "vlm_error" ? "VLM request failed" : "Invalid response", type: status },
      });
      prevFramePath = framePath;
      if (invalidCount >= 3) {
        const detail =
          errorKind === "vlm_error" ? `VLM request failed - ${errorMessage}` : "invalid or malformed JSON output";
        sessionOutcome = {
          status: "error",
          answer: null,
          confidence: null,
          error: `Model failed to produce a valid response after 3 consecutive attempts (last: ${detail}).`,
        };
        break;
      }
      consecutiveNonProgress++;
      correctiveFeedback =
        errorKind === "vlm_error"
          ? null
          : withEscalation("Your previous response was not valid JSON matching the required schema. Return STRICT JSON only.");
      continue;
    }

    onEvent({ type: "thought", idx, text: thought });

    onEvent({
      type: "action_planned",
      idx,
      action,
      label: describeAction(action, action.target_id ? (tracker.resolve(action.target_id) ?? null) : null),
    });

    if (action.type === "answer") {
      persistAndEmit({
        idx,
        thought,
        action,
        status: "ok",
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: describeAction(action, null), type: "answer" },
      });
      sessionOutcome = { status: "answered", answer: action.answer, confidence: action.confidence ?? null };
      break;
    }

    if (action.type === "fail") {
      persistAndEmit({
        idx,
        thought,
        action,
        status: "ok",
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: describeAction(action, null), type: "fail" },
      });
      sessionOutcome = { status: "failed", answer: null, confidence: null };
      break;
    }

    const key = actionKey(action);
    const dup = action.type !== "wait" ? history.find((h) => h.key === key && h.status === "ok") : null;

    if (dup) {
      persistAndEmit({
        idx,
        thought,
        action,
        status: "rejected_loop",
        errorMsg: `Duplicate of step #${dup.idx}`,
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: "Rejected: repeat action", type: action.type },
      });
      consecutiveNonProgress++;
      correctiveFeedback = withEscalation(
        `You already performed this exact action at step #${dup.idx}; its result is already visible in the current state. Choose a different action or answer now.`,
      );
      history.push({ idx, key, type: action.type, status: "rejected_loop" });
      prevFramePath = framePath;
      continue;
    }

    if (action.type === "wait") {
      consecutiveWaits++;
      if (consecutiveWaits > 2) {
        persistAndEmit({
          idx,
          thought,
          action,
          status: "rejected_loop",
          errorMsg: "Too many consecutive waits",
          framePath,
          inventory: inv,
          changedRegions,
          startedAt: stepStartedAt,
          durationMs,
          actionBadge: { text: "Rejected: too many waits", type: "wait" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("You have waited too many times in a row. Take a real action or answer now.");
        history.push({ idx, key, type: "wait", status: "rejected_loop" });
        prevFramePath = framePath;
        continue;
      }
      await waitForSettle(page, config.settleGate);
      persistAndEmit({
        idx,
        thought,
        action,
        status: "ok",
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: "Wait", type: "wait" },
      });
      history.push({ idx, key, type: "wait", status: "ok" });
      consecutiveNonProgress = 0;
      prevFramePath = framePath;
      continue;
    }
    consecutiveWaits = 0;

    const resolved = tracker.resolve(action.target_id);
    if (!resolved) {
      persistAndEmit({
        idx,
        thought,
        action,
        status: "rejected_target",
        errorMsg: `Unknown target_id "${action.target_id}"`,
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: "Rejected: unknown target", type: action.type },
      });
      consecutiveNonProgress++;
      correctiveFeedback = withEscalation(`"${action.target_id}" is not a valid id in the current inventory. Use one of the ids listed above.`);
      history.push({ idx, key, type: action.type, status: "rejected_target" });
      prevFramePath = framePath;
      continue;
    }

    const widgetBbox = await findWidgetBbox(page, resolved.field ?? resolved.name);
    if (widgetBbox) onEvent({ type: "widget_bbox", idx, bbox: widgetBbox });

    const execResult = await executeActionWithTimeout(page, resolved, action, config.actionTimeoutMs);

    if (!execResult.ok) {
      persistAndEmit({
        idx,
        thought,
        action,
        status: "error",
        errorMsg: execResult.error,
        framePath,
        inventory: inv,
        changedRegions,
        startedAt: stepStartedAt,
        durationMs,
        actionBadge: { text: `Error: ${action.type}`, type: action.type },
      });
      consecutiveNonProgress++;
      correctiveFeedback = withEscalation(
        execResult.nearMatches
          ? `${execResult.error} Closest available options: ${JSON.stringify(execResult.nearMatches)}.`
          : execResult.error,
      );
      history.push({ idx, key, type: action.type, status: "error" });
      prevFramePath = framePath;
      continue;
    }

    const settleResult = await waitForSettle(page, config.settleGate);
    if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

    persistAndEmit({
      idx,
      thought,
      action,
      status: "ok",
      framePath,
      inventory: inv,
      changedRegions,
      settleTimeout: settleResult.timedOut,
      startedAt: stepStartedAt,
      durationMs,
      actionBadge: { text: describeAction(action, resolved), type: action.type },
      widgetBbox,
    });
    history.push({ idx, key, type: action.type, status: "ok" });
    consecutiveNonProgress = 0;
    prevFramePath = framePath;
  }

  if (!sessionOutcome) {
    onEvent({ type: "warning", idx, kind: "max_steps" });
    const rawInv = await page.evaluate(() => window.__agentBridge.getInventory());
    const inv = tracker.normalize(rawInv);
    const forced = await forceBestEffortAnswer({ config, question, inventory: inv, history, framePath: prevFramePath });
    idx++;
    persistAndEmit({
      idx,
      thought: forced.thought,
      action: forced.action,
      status: "ok",
      framePath: prevFramePath,
      inventory: inv,
      changedRegions: [],
      startedAt: Date.now(),
      durationMs: 0,
      actionBadge: { text: `Forced final: ${describeAction(forced.action, null)}`, type: forced.action.type },
    });
    sessionOutcome = {
      status: "max_steps",
      answer: forced.action.type === "answer" ? forced.action.answer : null,
      confidence: forced.action.type === "answer" ? forced.action.confidence ?? null : null,
    };
  }

  store.finishSession(sessionId, {
    status: sessionOutcome.status,
    final_answer: sessionOutcome.answer,
    confidence: sessionOutcome.confidence,
    error_message: sessionOutcome.error ?? null,
  });
  onEvent({
    type: "session_done",
    status: sessionOutcome.status,
    final_answer: sessionOutcome.answer,
    confidence: sessionOutcome.confidence,
    error: sessionOutcome.error ?? null,
  });

  if (ownsPage) {
    await page.context().close();
  }

  return {
    sessionId,
    status: sessionOutcome.status,
    finalAnswer: sessionOutcome.answer,
    confidence: sessionOutcome.confidence,
  };
}

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
import { getNextAction, refineClickPoint, activeModelName } from "./vlmClient.js";
import { executeActionWithTimeout, describeAction } from "./actuator.js";
import * as store from "./store.js";
import { isNearDeadPoint } from "./pixelGuard.js";
import { createDiscoveryLog, stampFromInventory } from "./discoveries.js";

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
    case "click":
      return `click:${action.nx.toFixed(2)},${action.ny.toFixed(2)}`;
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

async function forceBestEffortAnswer({ config, question, inventory, history, discoveries, framePath }) {
  const feedback =
    "You have reached the maximum number of steps. Based on everything you have seen so far, provide your " +
    'best-effort final answer NOW. You must respond with an "answer" action (or "fail" only if truly impossible).';
  const { valid, discovery, thought, action } = await getNextAction({
    config,
    question,
    inventory,
    history,
    discoveries,
    imagePath: framePath,
    correctiveFeedback: feedback,
  });

  if (valid && (action.type === "answer" || action.type === "fail")) {
    return { thought, action, discovery };
  }
  return {
    thought: thought ?? "(no valid final response within the step budget)",
    action: { type: "fail", reason: "Model did not provide a usable answer within the step budget." },
    discovery: null,
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
  // Optional AbortSignal that fires when the user requests a stop. Threaded
  // into the VLM call so a stop aborts an in-flight (slow, pixel-mode) request
  // immediately, rather than only being noticed at the next step boundary.
  stopSignal,
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
  // Session-scoped hard-data memory. The conversation runtime passes its own
  // so facts survive across turns on one dashboard; standalone callers (CLI,
  // eval) get a fresh per-run log and need no change.
  discoveryLog: providedDiscoveryLog = null,
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
    model_id: activeModelName(config),
    config_json: JSON.stringify(config),
    conversation_id: conversationId,
    turn_index: turnIndex,
  });
  onEvent({ type: "session_started", sessionId, dashboardUrl, question });

  const tracker = createInventoryTracker();
  const discoveryLog = providedDiscoveryLog ?? createDiscoveryLog();
  // Emitted at most once per session - a cap warning per step would be noise.
  let discoveryCapWarned = false;
  let stepDiscovery = null;
  const history = [];
  let invalidCount = 0;
  let consecutiveWaits = 0;
  // Tracks steps in a row that made no real progress (rejected/errored),
  // regardless of whether they were exact repeats. Used to escalate
  // corrective feedback so the model re-scans the whole inventory instead
  // of retrying variations on the same wrong target_id.
  let consecutiveNonProgress = 0;
  let noDiffClicks = 0; // consecutive pixel clicks that produced no visible change
  const deadClickPoints = []; // {nx,ny} of clicks that produced no change (pixel mode); cleared when a click changes the view
  const deadClickRadius = config.pixel?.deadClickRadius ?? 0.05; // normalized radius for the repeat guard

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
    clickPoint = null,
  }) {
    const overlay = { action_badge: actionBadge, widget_bbox: widgetBbox, changed_regions: changedRegions, ...(clickPoint ? { click_point: clickPoint } : {}) };
    store.insertStep({
      session_id: sessionId,
      step_idx: idx,
      thought,
      discovery: stepDiscovery,
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
      discovery: stepDiscovery,
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
    stepDiscovery = null;
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

    const { valid, discovery, thought, action, rawText, errorKind, errorMessage } = await getNextAction({
      config,
      question,
      inventory: inv,
      history,
      discoveries: discoveryLog.format(),
      imagePath: framePath,
      correctiveFeedback,
      onAttempt: (attempt) => onEvent({ type: "vlm_attempt", idx, attempt }),
      stopSignal,
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
          error: `Model failed to produce a valid response on 3 steps in a row, 3 attempts each (last: ${detail}).`,
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

    // The model answered validly, so the invalid streak is over. Without this
    // reset invalidCount was cumulative-for-the-whole-run while being reported
    // as consecutive: three scattered bad steps across an otherwise healthy
    // 15-step run killed the session and blamed a streak that never happened.
    invalidCount = 0;

    // Recorded BEFORE the action runs, and kept even if the action is then
    // rejected by the loop guard or the zoom-refine pass: a rejected click
    // does not invalidate the reading. The model looked at this frame and read
    // a number off it; whether its aim was any good is a separate question.
    // Rejected steps are common in pixel mode, so discarding their readings
    // would throw away a large share of what the agent learns.
    const recorded = discoveryLog.add({
      text: discovery,
      turnIndex,
      stepIdx: idx,
      stateStamp: stampFromInventory(inv),
    });
    // What is shown and stored is what actually entered memory, so the UI can
    // never imply the agent learned something it discarded as a duplicate.
    stepDiscovery = recorded.accepted ? recorded.text : null;
    if (recorded.evicted && !discoveryCapWarned) {
      discoveryCapWarned = true;
      onEvent({ type: "warning", idx, kind: "discovery_cap" });
    }

    onEvent({ type: "thought", idx, text: thought, discovery: stepDiscovery });

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

    // Zoom-refine pass (pixel mode): the model's click is treated as a COARSE
    // aim, then re-placed inside an upscaled crop around it. Small controls -
    // an open dropdown's rows are ~2.6% of the frame's height - are below the
    // model's single-pass accuracy, which is what made it select the row above
    // the one it had reasoned about. Done here, before the loop key and the
    // dead-click guard, so every downstream consumer (guard, persistence,
    // history, cursor overlay, actuator) sees the one point actually clicked.
    if (action.type === "click" && (config.actuationMode ?? "pixel") === "pixel") {
      const refined = await refineClickPoint({
        config,
        imagePath: framePath,
        nx: action.nx,
        ny: action.ny,
        target: action.target ?? null,
        stopSignal,
      });
      if (refined?.notFound) {
        // The zoom check looked around the aim and the named target isn't
        // there. Firing anyway lands on whatever happens to be under the
        // point - which is how a stray click kept dismissing the dropdown the
        // previous step had just opened, alternating forever. Reject without
        // executing and tell the model what actually happened.
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: `"${action.target ?? "target"}" is not near (${action.nx.toFixed(2)},${action.ny.toFixed(2)})`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: wrong location", type: "click" },
          clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(
          `Your click was NOT executed: zooming in around (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) did not show "${action.target ?? "the target"}". ` +
            `Your coordinates are wrong, not slightly off — look at the screenshot again and read off where that element actually sits, ` +
            `remembering nx/ny are fractions of the WHOLE image.`,
        );
        history.push({ idx, key: actionKey(action), type: "click", status: "rejected_target", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }
      if (refined) {
        action.nx = refined.nx;
        action.ny = refined.ny;
      }
    }

    const key = actionKey(action);
    const dup =
      action.type !== "wait" && action.type !== "click"
        ? history.find((h) => h.key === key && h.status === "ok")
        : null;

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

    if (action.type === "click") {
      if ((config.actuationMode ?? "pixel") !== "pixel") {
        // Belt-and-suspenders: a click can only be produced in pixel mode.
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: "click is only valid in pixel actuation mode",
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: click not allowed", type: "click" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("This mode does not support click actions. Use the provided action types.");
        history.push({ idx, key, type: "click", status: "rejected_target", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // Enforced self-correction: reject a click near a location that already
      // produced no change, WITHOUT executing it (no wasted mouse dispatch or
      // settle cycle). The step budget + consecutiveNonProgress still terminate
      // a genuinely stuck run.
      if (isNearDeadPoint({ nx: action.nx, ny: action.ny }, deadClickPoints, deadClickRadius)) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Repeat click near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}), which already produced no change`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat dead click", type: "click" },
          clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback =
          `You already clicked near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) and nothing changed. Do NOT click there again. ` +
          `Aim at a clearly different location, or if several spots produce no change, the control may be hidden — answer from what is visible, or fail.`;
        history.push({ idx, key, type: "click", status: "rejected_loop", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      onEvent({ type: "agent_cursor", idx, nx: action.nx, ny: action.ny, phase: "move" });
      const execResult = await executeActionWithTimeout(page, null, action, config.actionTimeoutMs);
      onEvent({ type: "agent_cursor", idx, nx: action.nx, ny: action.ny, phase: "click" });

      if (!execResult.ok) {
        persistAndEmit({
          idx, thought, action, status: "error", errorMsg: execResult.error,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Error: click", type: "click" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(execResult.error);
        history.push({ idx, key, type: "click", status: "error", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // expectBridgeEvent: a mark click re-highlights the bar locally within
      // ~300ms but only re-filters the other worksheets after a server
      // round-trip (~2.3-3.3s). Without this the gate settles in the quiet gap
      // between the two and screenshots a dashboard that looks filtered but
      // is not - see settleDecision in perception.js.
      const settleResult = await waitForSettle(page, config.settleGate, { expectBridgeEvent: true });
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      // Did the click visibly change anything? Diff a fresh post-click frame
      // against this step's pre-click frame. Drives the corrective feedback and
      // the dead-click guard; the persisted frame stays the pre-action
      // screenshot, matching api-mode semantics.
      const postPath = framePath.replace(/\.png$/, "_post.png");
      let clickChanged = true;
      try {
        await screenshotViz(page, postPath);
        const regions = await computeChangedRegions(framePath, postPath).catch(() => []);
        clickChanged = regions.length > 0;
      } finally {
        fs.rmSync(postPath, { force: true });
      }

      persistAndEmit({
        idx, thought, action, status: "ok",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "click" },
        clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null },
      });
      history.push({ idx, key, type: "click", status: "ok", nx: action.nx, ny: action.ny, changed: clickChanged });

      if (!clickChanged) {
        deadClickPoints.push({ nx: action.nx, ny: action.ny });
        noDiffClicks++;
        const base = `Your click at (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) changed nothing — you missed the control or it is not on screen. Aim at a clearly different location.`;
        correctiveFeedback =
          noDiffClicks >= 2
            ? `${base} You have now clicked with no effect more than once. If several spots produce no change, the control may be hidden — answer from what is visible, or fail.`
            : base;
        consecutiveNonProgress++;
      } else {
        // The view moved — prior dead spots are stale and must not over-reject.
        deadClickPoints.length = 0;
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
      }
      prevFramePath = framePath;
      continue;
    }

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

    const settleResult = await waitForSettle(page, config.settleGate, { expectBridgeEvent: true });
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
    const forced = await forceBestEffortAnswer({
      config,
      question,
      inventory: inv,
      history,
      discoveries: discoveryLog.format(),
      framePath: prevFramePath,
    });
    idx++;
    // The forced call gets the same treatment as every regular step: its own
    // discovery (if any) is recorded into the log, and stepDiscovery is set
    // from what actually entered the log - not left over from the last
    // regular loop iteration, and not the raw model output.
    const forcedRecorded = discoveryLog.add({
      text: forced.discovery,
      turnIndex,
      stepIdx: idx,
      stateStamp: stampFromInventory(inv),
    });
    stepDiscovery = forcedRecorded.accepted ? forcedRecorded.text : null;
    if (forcedRecorded.evicted && !discoveryCapWarned) {
      discoveryCapWarned = true;
      onEvent({ type: "warning", idx, kind: "discovery_cap" });
    }
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

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
import { getNextAction, refineClickPoint, locateTarget, activeModelName } from "./vlmClient.js";
import { resolveClickPoint, isPostSearchClick } from "./clickAiming.js";
import { executeActionWithTimeout, describeAction } from "./actuator.js";
import * as store from "./store.js";
import { isNearDeadPoint, isNearDeadScroll, clearStaleGuards } from "./pixelGuard.js";
import { createDiscoveryLog, stampFromInventory, claimsAbsentTarget } from "./discoveries.js";

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
    case "scroll":
      return `scroll:${action.nx.toFixed(2)},${action.ny.toFixed(2)}:${action.direction}`;
    case "search":
      return `search:${action.text.toLowerCase()}`;
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
  // Index of the most recent step whose action actually changed dashboard state
  // (a successful set_filter/set_range_filter/set_parameter/switch_sheet, or a
  // click/scroll/search that moved the view). The ONLY consumer is the search
  // branch's dup guard below: search has no positional dead-point guard like
  // click/scroll, so an identical repeat search is rejected unless something
  // real has happened since its last occurrence - see that guard's comment.
  let lastStateChangeIdx = 0;
  const deadClickPoints = []; // {nx,ny} of clicks that produced no change (pixel mode); cleared when a click changes the view
  // There is deliberately NO cache of rejected AIMS. There used to be: an aim the
  // aiming pass refused was remembered and every nearby retry pre-rejected without
  // a model call. It turned a single wrong verdict into an unrecoverable run - on
  // the newlyweds dashboard a Region combobox aim accurate to ~2% was refused,
  // cached, and then every correct retry was blocked, so the session could only be
  // stopped. A rejection now means "not on this frame", which a scroll can change,
  // so it must not persist. See clickAiming.js.
  const deadClickRadius = config.pixel?.deadClickRadius ?? 0.05; // normalized radius for the repeat guard
  // {nx,ny,direction} of scrolls that produced no visible change - the pane was
  // already at its end, or nothing there scrolls. Those two are indistinguishable
  // (both give 0 changed regions), hence one message for both. Direction-keyed so
  // a bottomed-out pane stays scrollable back up.
  const deadScrollPoints = [];
  // Deliberately larger than deadClickRadius: the unit of scrolling is a whole
  // pane, so a control-sized radius lets the model nibble around inside one dead
  // pane and evade the guard.
  const scrollDeadRadius = config.pixel?.scrollDeadRadius ?? 0.10;
  const scrollNotchPx = config.pixel?.scrollNotchPx ?? 300;
  // How many changed regions prove a search actually filtered the list. A
  // FAILED search still echoes its own text and scores 1 region (one 86x53
  // grid cell, the differ's minimum unit), so zero-vs-nonzero cannot be the
  // test here the way it is for click and scroll.
  const searchMinRegions = config.pixel?.searchMinRegions ?? 2;
  // Measured pacing - see the actuator's comment. These are not tuning knobs to
  // shave for speed; dropping them is what takes the action from 7/8 to 2/8.
  const searchTypeDelayMs = config.pixel?.searchTypeDelayMs ?? 250;
  const searchSyncMs = config.pixel?.searchSyncMs ?? 1500;
  // One bundle so a view-changing action can invalidate every stale judgement at
  // once - see clearStaleGuards. Holds the SAME array instances, not copies.
  const guards = { deadClickPoints, deadScrollPoints };
  const isPixelMode = (config.actuationMode ?? "pixel") === "pixel";

  function withEscalation(feedback) {
    if (consecutiveNonProgress < 2) return feedback;
    const stuck = `${feedback} You have made no progress for ${consecutiveNonProgress} steps in a row. `;
    // The advice has to match what the model can actually change. In pixel mode
    // there is no target_id to swap and the inventory is reference material,
    // not a control surface - telling it to "pick a different id" there sent it
    // looking for a fix that does not exist while its real problem was the
    // coordinates.
    return isPixelMode
      ? stuck +
          `Stop re-aiming at the same region - your reading of the screenshot is what is wrong. ` +
          `Pick out the element by its neighbours (which chart or label is it beside? which corner of the image?), ` +
          `convert THAT to fractions, and sanity-check the magnitude before answering. ` +
          `If the element is genuinely not on screen, answer from what is visible, or fail.`
      : stuck +
          `Stop retrying variations of the same target_id - it is likely the wrong control entirely. ` +
          `Re-read the FULL inventory below, including BOTH the FILTERS and PARAMETERS sections (a dashboard ` +
          `can have a parameter and a filter that sound similar but only one of them is actually wired to what ` +
          `you see on screen), and pick a different id.`;
  }

  // (wrongAimFeedback removed with the rejected-aim cache. It asserted "your
  // coordinates are wrong, not slightly off", which the aiming pass cannot
  // actually establish - locate reports whether the element is on the FRAME, not
  // whether the aim was good - and saying it to a model that had aimed correctly
  // pushed it away from the right answer. The rejection path now states only what
  // was established, and suggests scrolling.)
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
    scrollPoint = null,
  }) {
    const overlay = {
      action_badge: actionBadge,
      widget_bbox: widgetBbox,
      changed_regions: changedRegions,
      ...(clickPoint ? { click_point: clickPoint } : {}),
      ...(scrollPoint ? { scroll_point: scrollPoint } : {}),
    };
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

    // Provenance of the point this step actually clicks, persisted alongside it.
    // The aiming pass OVERWRITES action.nx/ny, so without these two the step
    // record cannot answer the first question you ask of a bad run: did the model
    // aim there, or did a pass move it? That question went unanswerable through
    // two rounds of diagnosis on the Netflix dashboard.
    let aimSource = null;
    let rawAim = null;

    // Aiming pass (pixel mode): whole-frame locate first, then zoom-refine centred
    // on locate's answer. See clickAiming.js for the measurements behind that
    // order, for why the model's own aim is only a fallback, and for why refine
    // may not veto. Done before the loop key and the dead-click guard, so every
    // downstream consumer (guard, persistence, history, cursor overlay, actuator)
    // sees the one point actually clicked.
    // ...except straight after a search, where the aiming passes are the problem
    // rather than the fix: the search box displays the query text, so refine
    // snaps the click off the row and onto the box ~0.024 of frame height above
    // it. See isPostSearchClick for the measurements. The model's own aim was
    // correct in every observed post-search step, so use it untouched - which is
    // the same path a click with no `target` already takes.
    const skipAiming =
      action.type === "click" &&
      (config.actuationMode ?? "pixel") === "pixel" &&
      isPostSearchClick(history, action.target ?? null);
    if (skipAiming) {
      rawAim = { nx: action.nx, ny: action.ny };
      aimSource = "aim_post_search";
      onEvent({ type: "warning", idx, kind: "post_search_aim" });
    }

    if (!skipAiming && action.type === "click" && (config.actuationMode ?? "pixel") === "pixel") {
      rawAim = { nx: action.nx, ny: action.ny };
      const aimed = await resolveClickPoint({
        aim: { nx: action.nx, ny: action.ny },
        target: action.target ?? null,
        refine: (nx, ny) =>
          refineClickPoint({ config, imagePath: framePath, nx, ny, target: action.target ?? null, stopSignal }),
        locate: () =>
          locateTarget({ config, imagePath: framePath, target: action.target ?? null, stopSignal }),
      });

      if (aimed.rejected) {
        // locate searched the whole frame and declined, so the element is not on
        // this frame. The aim is
        // deliberately NOT cached: caching one bad verdict is what turned a correct
        // reading into a dead run on the newlyweds dashboard, and the frame changes
        // from one step to the next. The step budget and the
        // consecutiveNonProgress escalation are what bound a genuinely stuck run.
        //
        // The verdict is still worth one thing: it PROVES the target is not on
        // this frame, so a "discovery" recorded on this same step naming that same
        // element cannot be a reading - it is the model writing down what it
        // expected to find once it got there. Retract it before persisting, so the
        // fabrication never reaches the log, the next prompt, or the database.
        // Observed on the World Government Summit dashboard 2026-08-10. Narrow by
        // design: a reading about anything ELSE on this step is legitimate.
        if (recorded.accepted && claimsAbsentTarget(recorded.text, action.target)) {
          discoveryLog.retract(recorded.key);
          stepDiscovery = null;
          onEvent({ type: "warning", idx, kind: "discovery_retracted" });
        }
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: `"${action.target ?? "target"}" was not found anywhere on screen`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: not on screen", type: "click" },
          // Not moved by any pass, so the point IS the raw aim - recorded with an
          // explicit source so a reader never has to infer that.
          clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null, source: "rejected", aim: rawAim },
        });
        consecutiveNonProgress++;
        // States only what was established - the element is not on this frame - and
        // deliberately suggests NO specific remedy. The old wording ("your
        // coordinates are wrong, not slightly off") was frequently false and pushed
        // a correct reading away from the answer; naming a remedy here (e.g.
        // "scroll it into view") is just as likely to send the model chasing an
        // action that does not apply. Let it choose.
        correctiveFeedback = withEscalation(
          `"${action.target ?? "That element"}" was not found anywhere on the current screenshot, so the click was not executed. ` +
            `Your coordinates may well be fine - the element simply is not visible right now. Work with what IS on screen: ` +
            `target a different element, make it visible first, or answer from what you can see.`,
        );
        history.push({ idx, key: actionKey(action), type: "click", status: "rejected_target", nx: action.nx, ny: action.ny, changed: false });
        prevFramePath = framePath;
        continue;
      }

      action.nx = aimed.nx;
      action.ny = aimed.ny;
      aimSource = aimed.source;
    }

    const key = actionKey(action);
    // scroll is exempt like click: repeating a scroll is the normal way to travel
    // further down a long pane, so it must not be rejected as a duplicate.
    // search is exempt for the same reason, not because a repeated search is
    // always a genuine no-op: integration testing (task-8-report.md) reproduced
    // an agent that searched a filter list, discovered it also needed to change
    // a DIFFERENT filter (Type -> TV Show) to see the data it wanted, changed
    // it, and then had its legitimate second search - identical text, but now
    // against a completely different underlying candidate list - rejected as a
    // duplicate of the first. A filter change between two identical searches
    // makes the second one legitimate, so a permanent duplicate rule strands
    // the agent. A runaway search loop is bounded separately, further down:
    // the priorSameSearch / lastStateChangeIdx check (~410 lines below)
    // rejects an identical successful search as a loop unless something has
    // changed state since its last occurrence, and the ok_nochange path below
    // permits only one retry of a failed search before diverting. Escalating
    // consecutiveNonProgress feedback and the 15-step budget remain the
    // backstop behind those, same as for click and scroll.
    const dup =
      action.type !== "wait" && action.type !== "click" && action.type !== "scroll" && action.type !== "search"
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
          clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null, source: aimSource, aim: rawAim },
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

      // "ok" means the click hit something, NOT merely that the mouse event
      // dispatched. A click that changed nothing missed its target, and
      // persisting that as a plain "ok" made the viewer draw a green tick on a
      // step whose own corrective feedback says "you missed the control" - the
      // dead-click guard then rejects the NEXT attempt, so the first visible
      // sign of trouble is a rejection one step after the actual failure.
      // clickChanged was already computed for the guard and the feedback; this
      // just stops it from being the only consumer.
      persistAndEmit({
        idx, thought, action, status: clickChanged ? "ok" : "ok_nochange",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "click" },
        clickPoint: { nx: action.nx, ny: action.ny, target: action.target ?? null, source: aimSource, aim: rawAim },
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
        // Rejected aims go with them: the frame they were judged against is
        // gone, so a point that held nothing before may hold the target now.
        // Dead SCROLLS go too: a pane with nothing scrollable in it may have
        // just been replaced by one that scrolls.
        clearStaleGuards(guards);
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
        lastStateChangeIdx = idx;
      }
      prevFramePath = framePath;
      continue;
    }

    if (action.type === "scroll") {
      if (!isPixelMode) {
        // Belt-and-suspenders: a scroll can only be produced in pixel mode.
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: "scroll is only valid in pixel actuation mode",
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: scroll not allowed", type: "scroll" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("This mode does not support scroll actions. Use the provided action types.");
        history.push({ idx, key, type: "scroll", status: "rejected_target", nx: action.nx, ny: action.ny, direction: action.direction, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // Cheap guard on the raw aim first, so a pane already known not to move in
      // this direction costs no model call.
      if (isNearDeadScroll({ nx: action.nx, ny: action.ny, direction: action.direction }, deadScrollPoints, scrollDeadRadius)) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Repeat scroll ${action.direction} near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}), which already produced no change`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat dead scroll", type: "scroll" },
          scrollPoint: { nx: action.nx, ny: action.ny, direction: action.direction, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(
          `You already scrolled ${action.direction} near (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) and nothing changed. ` +
            `That area is either already scrolled to its end or has nothing scrollable in it. Scroll somewhere clearly different, or answer from what is visible.`,
        );
        history.push({ idx, key, type: "scroll", status: "rejected_loop", nx: action.nx, ny: action.ny, direction: action.direction, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // Aiming: locate ONLY, and never a rejection.
      //
      // No zoom-refine: refine's window is sized for a ~2.6%-tall dropdown row,
      // while a scrollable pane is ~0.10 x 0.61 of the frame. Pane-level
      // precision is all a wheel needs.
      //
      // locate stays, and NOT to save a wasted step. A bad aim can land on a
      // DIFFERENT pane that is also scrollable, so the agent scrolls the wrong
      // chart, the pixels change, the guard reads success, and the model then
      // reads a chart it never meant to move. That is a wrong-answer risk, not a
      // cost. Never rejecting is safe because a wheel that hits nothing is inert
      // (measured: 0 changed regions, 0.0000% diff) - unlike a stray click it
      // cannot dismiss a dropdown or select a mark.
      if (action.target) {
        const located = await locateTarget({ config, imagePath: framePath, target: action.target, stopSignal });
        if (located && !located.notFound) {
          action.nx = located.nx;
          action.ny = located.ny;
        }
      }

      // `key` was computed from the model's raw aim, before locate moved it. Once
      // aiming has run, the history line must describe the point actually acted
      // on, or the log disagrees with its own nx/ny.
      const aimedKey = actionKey(action);

      // Re-check after aiming: locate may have snapped the point onto a pane
      // already known to be dead. Free — it is a pure function.
      if (isNearDeadScroll({ nx: action.nx, ny: action.ny, direction: action.direction }, deadScrollPoints, scrollDeadRadius)) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Located target sits on a pane that already produced no change when scrolled ${action.direction}`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat dead scroll", type: "scroll" },
          scrollPoint: { nx: action.nx, ny: action.ny, direction: action.direction, target: action.target ?? null },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(
          `"${action.target ?? "That area"}" is in a pane that would not scroll ${action.direction} — it is at its end, or nothing there scrolls. ` +
            `Scroll a different chart, or answer from what is visible.`,
        );
        history.push({ idx, key: aimedKey, type: "scroll", status: "rejected_loop", nx: action.nx, ny: action.ny, direction: action.direction, changed: false });
        prevFramePath = framePath;
        continue;
      }

      onEvent({ type: "agent_cursor", idx, nx: action.nx, ny: action.ny, phase: "scroll" });
      // beforeWheel fires after the cursor is in position and before the wheel,
      // giving the guard below a baseline that ALREADY contains the hover
      // artifact our own mouse.move creates. See the diff for why that matters.
      const preWheelPath = framePath.replace(/\.png$/, "_prewheel.png");
      const execResult = await executeActionWithTimeout(page, null, action, config.actionTimeoutMs, {
        notchPx: scrollNotchPx,
        beforeWheel: () => screenshotViz(page, preWheelPath),
      });

      if (!execResult.ok) {
        fs.rmSync(preWheelPath, { force: true });
        persistAndEmit({
          idx, thought, action, status: "error", errorMsg: execResult.error,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Error: scroll", type: "scroll" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(execResult.error);
        history.push({ idx, key: aimedKey, type: "scroll", status: "error", nx: action.nx, ny: action.ny, direction: action.direction, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // NO expectBridgeEvent. A scroll is a local re-render: it fires no
      // FilterChanged/ParameterChanged/TabSwitched, so demanding an event would
      // burn the full eventGraceMs on every scroll waiting for one that can never
      // arrive. This is the case settleDecision's !expectBridgeEvent branch is for.
      const settleResult = await waitForSettle(page, config.settleGate);
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      // Host containment. If the wheel bubbled past every pane to the host page,
      // the viz box moves, vizExtractRect returns null, and every LATER capture
      // falls onto the clipped-screenshot path that makes the live view stutter -
      // a rendering regression with no obvious link to scrolling. Undo it and
      // treat the step as having moved nothing.
      const hostScrolled = await page
        .evaluate(() => {
          const moved = window.scrollX !== 0 || window.scrollY !== 0;
          if (moved) window.scrollTo(0, 0);
          return moved;
        })
        .catch(() => false);

      // Did the pane actually move? scrollTop is useless here - Tableau leaves it
      // at 0 and re-renders instead - so the pixel diff is the only witness.
      //
      // Diffed against the PRE-WHEEL frame, not this step's persisted frame. Our
      // own mouse.move leaves a highlight on the row beneath it, and that
      // highlight PERSISTS after the cursor leaves; against the step's original
      // frame, a wheel on a pane already at its end still shows the highlight
      // appearing and would read as a successful scroll.
      const postPath = framePath.replace(/\.png$/, "_post.png");
      // Initialized to the fail-OPEN value, matching the click branch: if the
      // capture itself throws, assume the scroll worked rather than recording a
      // dead point on an infrastructure error. A false dead point is the worse
      // failure - it permanently blocks a pane that really does scroll.
      let scrollChanged = !hostScrolled;
      try {
        await screenshotViz(page, postPath);
        const regions = await computeChangedRegions(preWheelPath, postPath).catch(() => []);
        scrollChanged = regions.length > 0 && !hostScrolled;
      } finally {
        fs.rmSync(postPath, { force: true });
        fs.rmSync(preWheelPath, { force: true });
      }

      // Same rule as the click branch: a wheel that moved no pixels did not
      // scroll, whatever the mouse dispatch reported. (Here the two cases the
      // guard cannot tell apart - pane already at its end, and nothing
      // scrollable under the cursor - are both genuinely "no effect", so one
      // status covers them.)
      persistAndEmit({
        idx, thought, action, status: scrollChanged ? "ok" : "ok_nochange",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "scroll" },
        scrollPoint: { nx: action.nx, ny: action.ny, direction: action.direction, target: action.target ?? null },
      });
      history.push({ idx, key: aimedKey, type: "scroll", status: "ok", nx: action.nx, ny: action.ny, direction: action.direction, changed: scrollChanged });

      if (!scrollChanged) {
        deadScrollPoints.push({ nx: action.nx, ny: action.ny, direction: action.direction });
        correctiveFeedback = hostScrolled
          ? `Your scroll moved the page instead of the chart, so the dashboard did not change. Aim INSIDE a chart that is visibly cut off, not at the dashboard's edge or margin.`
          : `Your scroll ${action.direction} at (${action.nx.toFixed(2)},${action.ny.toFixed(2)}) changed nothing — that area is either already scrolled to its end or has nothing scrollable in it. ` +
            `Scroll somewhere clearly different, or answer from what is visible.`;
        consecutiveNonProgress++;
      } else {
        // The view moved, so every guard judgement made against the old frame is
        // stale — including the CLICK ones.
        clearStaleGuards(guards);
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
        lastStateChangeIdx = idx;
      }
      prevFramePath = framePath;
      continue;
    }

    if (action.type === "search") {
      if (!isPixelMode) {
        // Belt-and-suspenders: a search can only be produced in pixel mode.
        persistAndEmit({
          idx, thought, action, status: "rejected_target",
          errorMsg: "search is only valid in pixel actuation mode",
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: search not allowed", type: "search" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation("This mode does not support search actions. Use the provided action types.");
        history.push({ idx, key, type: "search", status: "rejected_target", text: action.text, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // search has no positional dead-point guard like click/scroll (there are no
      // coordinates to be "near"), so without this it has NO repeat guard at all -
      // worse, a SUCCEEDING repeat resets consecutiveNonProgress/noDiffClicks and
      // calls clearStaleGuards, so an alternation of dead-click -> search ->
      // dead-click -> search never accumulates non-progress and wipes every dead
      // point each cycle. Reject an identical repeat ONLY when its last successful
      // occurrence is still the most recent state change - i.e. nothing has
      // happened since (a filter, a different search, a click/scroll that moved
      // the view) that could make the repeat meaningful. This preserves the case
      // the dup exemption exists for: search "X" -> discover Type also needs to be
      // TV Show -> set it -> the identical search "X" again is now against a
      // different candidate list and must be allowed.
      //
      // Matched on CHANGED occurrences only (not failed ones): a search that
      // failed to filter is not "state", so retrying it is not a duplicate - that
      // retry is exactly what the corrective feedback below now permits once.
      const priorSameSearch = [...history].reverse().find((h) => h.type === "search" && h.key === key && h.changed === true);
      if (priorSameSearch && lastStateChangeIdx <= priorSameSearch.idx) {
        persistAndEmit({
          idx, thought, action, status: "rejected_loop",
          errorMsg: `Duplicate of step #${priorSameSearch.idx}; nothing has changed since`,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Rejected: repeat search", type: "search" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(
          `You already searched for ${JSON.stringify(action.text)} at step #${priorSameSearch.idx} and nothing has changed since; its result is already visible. Choose a different action or answer now.`,
        );
        history.push({ idx, key, type: "search", status: "rejected_loop", text: action.text, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // No aiming pass and no cursor movement, so unlike scroll there is no
      // hover artifact to baseline around: the step's own frame is a clean
      // "before". No agent_cursor event either - there is no point to draw.
      const execResult = await executeActionWithTimeout(page, null, action, config.actionTimeoutMs, {
        typeDelayMs: searchTypeDelayMs,
        syncMs: searchSyncMs,
      });

      if (!execResult.ok) {
        persistAndEmit({
          idx, thought, action, status: "error", errorMsg: execResult.error,
          framePath, inventory: inv, changedRegions,
          startedAt: stepStartedAt, durationMs,
          actionBadge: { text: "Error: search", type: "search" },
        });
        consecutiveNonProgress++;
        correctiveFeedback = withEscalation(execResult.error);
        history.push({ idx, key, type: "search", status: "error", text: action.text, changed: false });
        prevFramePath = framePath;
        continue;
      }

      // NO expectBridgeEvent. The search re-renders the list locally and applies
      // no filter, so no filterchanged/parameterchanged/tabswitched can ever
      // arrive and demanding one burns the full eventGraceMs every time. Same
      // branch scroll takes.
      const settleResult = await waitForSettle(page, config.settleGate);
      if (settleResult.timedOut) onEvent({ type: "warning", idx, kind: "settle_timeout" });

      const postPath = framePath.replace(/\.png$/, "_post.png");
      // Fail OPEN on a capture error, matching the click and scroll branches: a
      // false negative here tells the model its search failed when it worked.
      let searchRan = true;
      try {
        await screenshotViz(page, postPath);
        const regions = await computeChangedRegions(framePath, postPath).catch(() => []);
        // The region count is the ONLY witness. Across 32 measured runs every
        // clean full match scored 3 regions and every no-op scored 0. It answers
        // "something changed", not "the right thing changed" - a search that
        // landed on a corrupted partial term also scores 3. That residual case is
        // caught downstream instead: the next step must name the row it clicks,
        // and refineClickPoint makes it quote text it can actually see, so a
        // wrongly-filtered list yields a rejected click, not a wrong selection.
        searchRan = regions.length >= searchMinRegions;
      } finally {
        fs.rmSync(postPath, { force: true });
      }

      persistAndEmit({
        idx, thought, action, status: searchRan ? "ok" : "ok_nochange",
        framePath, inventory: inv, changedRegions,
        settleTimeout: settleResult.timedOut,
        startedAt: stepStartedAt, durationMs,
        actionBadge: { text: describeAction(action, null), type: "search" },
      });
      history.push({ idx, key, type: "search", status: "ok", text: action.text, changed: searchRan });

      if (!searchRan) {
        // The action fails transiently roughly 1 time in 8 (finding 12's
        // 7/8-clean-match measurement means ~1/8 genuinely don't land), so a flat
        // "do not repeat it" steers the agent onto the exact scroll-the-whole-list
        // route search was built to replace after a single bad roll. Permit
        // exactly one retry of the SAME term before diverting - this stays
        // compatible with the dup guard above, which only blocks a repeat of a
        // successful (changed:true) search, never a failed one.
        // Exclude the current step (already pushed into history above, so a naive
        // count is always >=1 on the very first failure and the priorFailures===0
        // branch below can never fire) and exclude rejected_loop entries (pushed
        // with changed:false but never actually dispatched - counting one would
        // silently spend the one permitted retry on a search that never ran).
        const priorFailures = history.filter(
          (h) => h.idx !== idx && h.type === "search" && h.key === key && h.status === "ok" && h.changed === false,
        ).length;
        correctiveFeedback =
          priorFailures === 0
            ? `Your search for ${JSON.stringify(action.text)} did not filter the list - it is still showing the same entries. ` +
              `This can happen transiently. Try the exact same search once more.`
            : `Your search for ${JSON.stringify(action.text)} has now failed twice - the search box is not responding. ` +
              `Do not repeat it again. Click the value directly in the list if you can see it, or answer from what is visible.`;
        consecutiveNonProgress++;
      } else {
        // The list is now a handful of rows instead of thousands, so every guard
        // judgement made against the old view is stale.
        clearStaleGuards(guards);
        noDiffClicks = 0;
        consecutiveNonProgress = 0;
        lastStateChangeIdx = idx;
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
    lastStateChangeIdx = idx;
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

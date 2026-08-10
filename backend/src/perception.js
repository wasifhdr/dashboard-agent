import fs from "node:fs";

import { chromium } from "playwright";
import sharp from "sharp";
import pixelmatch from "pixelmatch";

// Must match the id set on the <tableau-viz> element in public/host.html.
// (Tableau's own internal iframe reuses id="viz", so a distinct id here
// avoids Playwright locator ambiguity — see AGENT_PLAN.md Phase 0 notes.)
const VIZ_SELECTOR = "tableau-viz#agentViz";

export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

// Opens a new page against the host page for the given Tableau view URL and
// waits (with an explicit, bounded timeout) for the bridge to report the
// viz interactive. Uses waitForFunction polling on plain state, NOT
// page.evaluate() on the bridge's raw ready Promise, because an evaluate on
// a promise that never settles hangs forever with no timeout of its own.
export async function openSession(browser, hostOrigin, vizUrl, { firstLoadTimeoutMs = 90000 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
  const page = await context.newPage();
  const hostUrl = `${hostOrigin}/host?viz=${encodeURIComponent(vizUrl)}&dev=0`;

  await page.goto(hostUrl, { waitUntil: "domcontentloaded", timeout: firstLoadTimeoutMs });

  try {
    await page.waitForFunction(
      () => window.__agentBridgeState?.interactive === true || !!window.__agentBridgeState?.loadError,
      null,
      { timeout: firstLoadTimeoutMs },
    );
  } catch (e) {
    throw new Error(`Viz never became interactive within ${firstLoadTimeoutMs}ms: ${e.message}`);
  }

  const state = await page.evaluate(() => window.__agentBridgeState);
  if (state.loadError) {
    throw new Error(`Viz load error: ${state.loadError}`);
  }

  return { context, page };
}

// Pure: the viz rectangle as an integer crop of the viewport, or null when the
// element isn't fully inside the viewport (in which case a viewport screenshot
// physically cannot contain all of it and the caller must fall back).
// Split out so the arithmetic is unit-testable without a browser.
export function vizExtractRect(box, viewport) {
  if (!box || !viewport || !viewport.width || !viewport.height) return null;
  if (!box.width || !box.height) return null;
  const EPS = 0.5; // sub-pixel layout positions are not "outside the viewport"
  const fits =
    box.x >= -EPS &&
    box.y >= -EPS &&
    box.x + box.width <= viewport.width + EPS &&
    box.y + box.height <= viewport.height + EPS;
  if (!fits) return null;
  const left = Math.max(0, Math.round(box.x));
  const top = Math.max(0, Math.round(box.y));
  return {
    left,
    top,
    width: Math.min(Math.round(box.width), viewport.width - left),
    height: Math.min(Math.round(box.height), viewport.height - top),
  };
}

// The viz as PNG bytes.
//
// Deliberately NOT `locator.screenshot()`: that is a *clipped* capture, and
// Chromium services a clipped capture by re-rendering the page at the clip's
// device metrics, which an active CDP screencast then broadcasts as a real
// frame - the dashboard blown up to fill the surface for a frame or two.
// Captured in the wild during a real agent turn: a 258KB frame among 183KB
// neighbours, on screen for ~475ms. Taking the shot UNCLIPPED and cropping it
// here produces byte-identical output with no re-render at all (measured 0
// distorted frames over 8 captures, vs 8/8 clipped), so the live view needs no
// suppression and can never be left holding a stale or distorted frame.
//
// The fallback keeps the old behaviour when the viz is bigger than the
// viewport, where a viewport screenshot would silently truncate what the model
// sees. Correctness of the agent's input beats a smooth live view, so that
// path clips and accepts the pop. No configured dashboard reaches it - all
// five publish sizes that fit inside 1920x1200.
async function captureVizPng(page) {
  const box = await page.locator(VIZ_SELECTOR).boundingBox();
  const rect = vizExtractRect(box, page.viewportSize());
  if (rect) {
    const full = await page.screenshot({ type: "png" });
    return await sharp(full).extract(rect).png().toBuffer();
  }
  return await page.locator(VIZ_SELECTOR).screenshot({ type: "png" });
}

async function rawSmallBuffer(page) {
  const buf = await captureVizPng(page);
  const { data, info } = await sharp(buf)
    .resize({ width: 640 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Pure settle decision, split out so the logic is unit-testable without a
// browser (test/settleDecision.test.js).
//
// Pixel stability alone cannot tell "the dashboard finished redrawing" from
// "the dashboard has not started redrawing yet". Clicking a mark does two
// things at very different speeds: the clicked bar re-highlights immediately
// (local, <300ms) and the OTHER worksheets re-filter only after a server
// round-trip (measured 2.3-3.3s on Video Game Sales). The pixels go quiet in
// the gap between them, so the old gate declared settled at ~1.1s and
// screenshotted a dashboard that looked filtered but was not - the model then
// read the stale chart and answered confidently wrong, with settle_timeout=0
// and nothing logged as an error.
//
// The bridge fires filterchanged/markselectionchanged exactly when the
// round-trip lands, so after an action we additionally require either
//   - an event to have arrived AND gone quiet for eventQuietMs, or
//   - eventGraceMs to have passed with no event at all (the click hit nothing).
export function settleDecision({
  pixelsStable,
  expectBridgeEvent,
  sawEvent,
  msSinceLastEvent,
  elapsedMs,
  eventQuietMs,
  eventGraceMs,
}) {
  if (!pixelsStable) return "wait";
  // Load/no-op path keeps the original pixels-only behavior: nothing was done,
  // so there is no pending round-trip to wait for.
  if (!expectBridgeEvent) return "settled";
  if (sawEvent) return msSinceLastEvent >= eventQuietMs ? "settled" : "wait";
  return elapsedMs >= eventGraceMs ? "settled" : "wait";
}

// Reads the bridge's event log. msSinceLast is computed INSIDE the page so it
// never depends on Node and browser clocks agreeing. Never throws - a page
// without the bridge (or mid-navigation) simply reports no events, which
// degrades to the grace-window path rather than breaking the gate.
async function readBridgeEvents(page) {
  try {
    return await page.evaluate(() => {
      const log = window.__agentBridge?.getEventLog?.() ?? [];
      if (!log.length) return { count: 0, msSinceLast: null };
      return { count: log.length, msSinceLast: Date.now() - log[log.length - 1].ts };
    });
  } catch {
    return { count: 0, msSinceLast: null };
  }
}

// Settle gate (AGENT_PLAN.md 6.4): Embedding API promises can resolve before
// rendering finishes, so we poll a downscaled screenshot diff until it
// stabilizes (or time out and proceed with a warning flag).
//
// Pass { expectBridgeEvent: true } after anything that mutates the viz, so the
// gate also waits out the server round-trip described on settleDecision above.
export async function waitForSettle(page, settleConfig, { expectBridgeEvent = false } = {}) {
  const {
    postActionWaitMs,
    compareIntervalMs,
    diffThresholdPct,
    timeoutMs,
    eventQuietMs = 700,
    eventGraceMs = 4500,
  } = settleConfig;

  const startedAt = Date.now();
  // Baseline BEFORE the wait, so an event that fires during postActionWaitMs
  // still counts as "seen" rather than being silently folded into the baseline.
  const baseline = expectBridgeEvent ? (await readBridgeEvents(page)).count : 0;
  await page.waitForTimeout(postActionWaitMs);

  const deadline = startedAt + timeoutMs;
  let prev = await rawSmallBuffer(page);

  while (Date.now() < deadline) {
    await page.waitForTimeout(compareIntervalMs);
    const curr = await rawSmallBuffer(page);

    if (curr.width !== prev.width || curr.height !== prev.height) {
      // Dashboard resized (e.g. sheet switch changed layout) - not settled yet.
      prev = curr;
      continue;
    }

    const diffCount = pixelmatch(prev.data, curr.data, null, curr.width, curr.height, { threshold: 0.1 });
    const diffPct = (diffCount / (curr.width * curr.height)) * 100;
    prev = curr;

    const pixelsStable = diffPct < diffThresholdPct;
    let sawEvent = false;
    let msSinceLastEvent = null;
    if (pixelsStable && expectBridgeEvent) {
      const ev = await readBridgeEvents(page);
      sawEvent = ev.count > baseline;
      msSinceLastEvent = ev.msSinceLast;
    }

    const decision = settleDecision({
      pixelsStable,
      expectBridgeEvent,
      sawEvent,
      msSinceLastEvent,
      elapsedMs: Date.now() - startedAt,
      eventQuietMs,
      eventGraceMs,
    });
    if (decision === "settled") {
      return { settled: true, timedOut: false, sawBridgeEvent: sawEvent };
    }
  }
  return { settled: false, timedOut: true, sawBridgeEvent: false };
}

export async function screenshotViz(page, outPath) {
  const buf = await captureVizPng(page);
  await fs.promises.writeFile(outPath, buf);
}

// Coarse bounding-box clustering of pixel-diff regions between two frames,
// for the "changed_regions" overlay (AGENT_PLAN.md 6.6). Heuristic, not
// exact segmentation - good enough to point a viewer at "look here".
export async function computeChangedRegions(beforePath, afterPath, { maxRegions = 3 } = {}) {
  const [bMeta, aMeta] = await Promise.all([sharp(beforePath).metadata(), sharp(afterPath).metadata()]);
  const width = Math.min(bMeta.width, aMeta.width);
  const height = Math.min(bMeta.height, aMeta.height);
  if (!width || !height) return [];

  const [bBuf, aBuf] = await Promise.all([
    sharp(beforePath).resize(width, height).ensureAlpha().raw().toBuffer(),
    sharp(afterPath).resize(width, height).ensureAlpha().raw().toBuffer(),
  ]);

  const diffMask = Buffer.alloc(width * height * 4);
  pixelmatch(bBuf, aBuf, diffMask, width, height, { threshold: 0.1, diffMask: true });

  const GRID = 20;
  const cellW = Math.ceil(width / GRID);
  const cellH = Math.ceil(height / GRID);
  const cellCounts = new Array(GRID * GRID).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (diffMask[idx + 3] !== 0) {
        const gx = Math.min(GRID - 1, Math.floor(x / cellW));
        const gy = Math.min(GRID - 1, Math.floor(y / cellH));
        cellCounts[gy * GRID + gx]++;
      }
    }
  }

  const cellThreshold = Math.max(5, cellW * cellH * 0.02);
  const hotCells = cellCounts
    .map((count, i) => ({ count, gx: i % GRID, gy: Math.floor(i / GRID) }))
    .filter((c) => c.count >= cellThreshold)
    .sort((a, b) => b.count - a.count);

  if (hotCells.length === 0) return [];

  const regions = [];
  const used = new Set();
  for (const cell of hotCells) {
    const key = `${cell.gx},${cell.gy}`;
    if (used.has(key) || regions.length >= maxRegions) continue;

    let minGx = cell.gx, maxGx = cell.gx, minGy = cell.gy, maxGy = cell.gy;
    used.add(key);
    for (const other of hotCells) {
      const okey = `${other.gx},${other.gy}`;
      if (used.has(okey)) continue;
      if (Math.abs(other.gx - cell.gx) <= 2 && Math.abs(other.gy - cell.gy) <= 2) {
        used.add(okey);
        minGx = Math.min(minGx, other.gx);
        maxGx = Math.max(maxGx, other.gx);
        minGy = Math.min(minGy, other.gy);
        maxGy = Math.max(maxGy, other.gy);
      }
    }

    regions.push({
      x: minGx * cellW,
      y: minGy * cellH,
      w: Math.min(width - minGx * cellW, (maxGx - minGx + 1) * cellW),
      h: Math.min(height - minGy * cellH, (maxGy - minGy + 1) * cellH),
    });
  }

  return regions;
}

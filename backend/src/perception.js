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

async function rawSmallBuffer(page) {
  const buf = await page.locator(VIZ_SELECTOR).screenshot({ type: "png" });
  const { data, info } = await sharp(buf)
    .resize({ width: 640 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Settle gate (AGENT_PLAN.md 6.4): Embedding API promises can resolve before
// rendering finishes, so we poll a downscaled screenshot diff until it
// stabilizes (or time out and proceed with a warning flag).
export async function waitForSettle(page, settleConfig) {
  const { postActionWaitMs, compareIntervalMs, diffThresholdPct, timeoutMs } = settleConfig;
  await page.waitForTimeout(postActionWaitMs);

  const deadline = Date.now() + timeoutMs;
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
    if (diffPct < diffThresholdPct) {
      return { settled: true, timedOut: false };
    }
    prev = curr;
  }
  return { settled: false, timedOut: true };
}

export async function screenshotViz(page, outPath) {
  await page.locator(VIZ_SELECTOR).screenshot({ path: outPath });
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

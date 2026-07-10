// One-time generator for the chart-reading micro-benchmark. Crops fixed
// regions out of already-verified real session/probe frames (expected
// values were confirmed by eye during Phase 1-3 development) and writes a
// manifest for eval/reading-bench.js to run repeatably against whichever
// model is currently loaded in llama-server.
//
// Usage: node eval/reading/build-crops.js

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = __dirname;

const CROPS = [
  {
    id: "r1_zhvi_us_value",
    source: "data/frames/0a6545a2-2d82-4b46-9c81-8352a4349685/step_1.png",
    rect: { left: 0, top: 0, width: 600, height: 90 },
    prompt: "What single dollar value is stated in this text? Reply with just the number.",
    expected: "$226,800",
  },
  {
    id: "r2_zri_us_value",
    source: "data/frames/75e054d8-e887-4fff-b26a-784c039bac59/step_2.png",
    rect: { left: 0, top: 0, width: 600, height: 90 },
    prompt: "What single dollar value is stated in this text? Reply with just the number.",
    expected: "$1,477",
  },
  {
    id: "r3_zhvi_boston_value",
    source: "data/frames/50a26e2b-317b-4154-9c58-6a49f3586c06/step_5.png",
    rect: { left: 0, top: 0, width: 600, height: 90 },
    prompt: "What single dollar value is stated in this text? Reply with just the number.",
    expected: "$465,000",
  },
  {
    id: "r4_overthehill_older_pct",
    source: "data/frames/e22d5a2a-92fc-445f-8ec7-2552d77215fc/step_2.png",
    rect: { left: 0, top: 555, width: 700, height: 145 },
    prompt: "What percentage is shown next to 'Older than you'? Reply with just the percentage.",
    expected: "48.9%",
  },
  {
    id: "r5_ca_disease_map_legend",
    source: "data/frames/7220ddb6-cfc0-49fe-8cbe-f0a3a0729403/step_2.png",
    rect: { left: 0, top: 595, width: 160, height: 55 },
    prompt: "What is the minimum and maximum value shown on this 'Percent' color-scale legend? Reply concisely.",
    expected: "0.04%",
  },
  {
    id: "r6_ca_disease_year_sex",
    source: "data/frames/_probe_https_public_tableau_com_views_CAInfectiousDiseases_CAInfect/before.png",
    rect: { left: 740, top: 5, width: 289, height: 75 },
    prompt: "What year is shown in the Year control, and what is currently selected in the Sex dropdown? Reply concisely.",
    expected: "2015",
  },
  {
    id: "r7_redfin_controls",
    source: "data/frames/_probe_https_public_tableau_com_views_EHSPublic_EHSDashboard/before.png",
    rect: { left: 0, top: 55, width: 800, height: 60 },
    prompt: "What is currently selected in the 'Seasonally Adjusted' dropdown? Reply with just the value.",
    expected: "True",
  },
  {
    id: "r8_redfin_latest_value",
    source: "data/frames/_probe_https_public_tableau_com_views_EHSPublic_EHSDashboard/before.png",
    rect: { left: 550, top: 260, width: 250, height: 140 },
    prompt: "What numeric value is labeled on the chart near the end of the line? Reply with just the number.",
    expected: "4,222,253",
  },
  {
    id: "r9_ca_revenue_waterfall",
    source: "data/frames/_probe_https_public_tableau_com_views_CAStateRevenues_10_0_CAIncome/before.png",
    rect: { left: 355, top: 130, width: 380, height: 400 },
    prompt: "In this waterfall chart, what percentage is labeled for the 'Sales Tax' bar? Reply with just the percentage.",
    expected: "28.3%",
  },
  {
    id: "r10_ca_revenue_date_range",
    source: "data/frames/_probe_https_public_tableau_com_views_CAStateRevenues_10_0_CAIncome/before.png",
    rect: { left: 165, top: 45, width: 175, height: 60 },
    prompt: "What are the min and max years shown on the 'Select Date' range slider? Reply concisely.",
    expected: "1951",
  },
];

async function main() {
  const manifest = [];
  for (const c of CROPS) {
    const sourcePath = path.join(BACKEND_ROOT, c.source);
    const outPath = path.join(OUT_DIR, `${c.id}.png`);
    await sharp(sourcePath).extract(c.rect).png().toFile(outPath);
    manifest.push({ id: c.id, image: `${c.id}.png`, prompt: c.prompt, expected: c.expected, source: c.source });
    console.log(`wrote ${outPath}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest.json with ${manifest.length} crops.`);
}

main().catch((err) => {
  console.error("BUILD-CROPS FAILED:", err);
  process.exit(1);
});

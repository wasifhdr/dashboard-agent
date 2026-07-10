// Chart-reading micro-benchmark: repeatable runner against whichever
// model is currently loaded in llama-server. Run once per model (swap via
// scripts/start-llama.ps1 vs scripts/start-llama-stock.ps1) and compare.
//
// Usage: node eval/reading-bench.js [--label some-name]

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, "config.json"), "utf-8"));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "reading", "manifest.json"), "utf-8"));

const labelArgIdx = process.argv.indexOf("--label");
const label = labelArgIdx !== -1 ? process.argv[labelArgIdx + 1] : config.modelName;

function fileToDataUrl(filePath) {
  const b64 = fs.readFileSync(filePath).toString("base64");
  return `data:image/png;base64,${b64}`;
}

// Loose match: normalize whitespace/case and check the expected value
// appears in the response - a reading test, not a strict-format test.
function isMatch(response, expected) {
  const norm = (s) => s.toLowerCase().replace(/[,\s$%]+/g, "");
  return norm(response).includes(norm(expected));
}

async function askModel(imagePath, prompt) {
  const payload = {
    model: config.modelName,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: fileToDataUrl(imagePath) } },
        ],
      },
    ],
    temperature: 0.0,
    max_tokens: 600,
  };

  const res = await fetch(`${config.llamaEndpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`llama-server error ${res.status}: ${bodyText.slice(0, 300)}`);
  const json = JSON.parse(bodyText);
  return json?.choices?.[0]?.message?.content ?? "";
}

async function main() {
  console.log(`Reading benchmark - model label: "${label}"`);
  console.log(`Endpoint: ${config.llamaEndpoint}\n`);

  const results = [];
  let passCount = 0;

  for (const item of manifest) {
    const imagePath = path.join(__dirname, "reading", item.image);
    const startedAt = Date.now();
    let response = "";
    let error = null;
    try {
      response = (await askModel(imagePath, item.prompt)).trim();
    } catch (e) {
      error = e.message;
    }
    const durationMs = Date.now() - startedAt;
    const pass = !error && isMatch(response, item.expected);
    if (pass) passCount++;

    console.log(`[${item.id}] expected="${item.expected}" -> ${error ? `ERROR: ${error}` : `"${response}"`} ${pass ? "PASS" : "FAIL"} (${(durationMs / 1000).toFixed(1)}s)`);
    results.push({ id: item.id, expected: item.expected, response, pass, error, durationMs });
  }

  const score = `${passCount}/${manifest.length}`;
  console.log(`\nScore: ${score}`);

  const outPath = path.join(__dirname, "reading", `results-${label.replace(/[^a-z0-9]+/gi, "_")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ label, endpoint: config.llamaEndpoint, score, results }, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error("READING-BENCH FAILED:", err);
  process.exit(1);
});

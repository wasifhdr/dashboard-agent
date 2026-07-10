// Sanity-checks that the configured VLM can actually read a dense chart image.
// Run with llama-server already running (see start-llama.ps1).
//
// Usage: node scripts/vision-smoke-test.js <path-to-image.png>

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Usage: node scripts/vision-smoke-test.js <path-to-image.png>");
  process.exit(1);
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const b64 = readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function main() {
  await readFile(imagePath); // throws clearly if missing

  const prompt =
    "Look carefully at this dashboard screenshot. List EVERY number, " +
    "axis label, legend entry, and text label you can actually read in the " +
    "image, as a plain bullet list. Do not summarize or interpret — just " +
    "transcribe what is visibly printed. If you cannot read something " +
    "clearly, say so instead of guessing.";

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
  };

  console.log(`[smoke-test] endpoint: ${config.llamaEndpoint}`);
  console.log(`[smoke-test] image: ${imagePath}`);
  console.log("[smoke-test] sending request (this can take a while on 6GB VRAM)...\n");

  const started = Date.now();
  const res = await fetch(`${config.llamaEndpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  const elapsedS = ((Date.now() - started) / 1000).toFixed(1);

  if (!res.ok) {
    console.error(`[smoke-test] FAILED — HTTP ${res.status} after ${elapsedS}s`);
    console.error(bodyText.slice(0, 2000));
    process.exit(1);
  }

  const json = JSON.parse(bodyText);
  const reply = json?.choices?.[0]?.message?.content ?? "(empty response)";

  console.log(`[smoke-test] response in ${elapsedS}s:\n`);
  console.log(reply);
  console.log(
    "\n[smoke-test] MANUAL CHECK: does the list above contain real numbers/" +
    "labels that plausibly match what's in the image (not hallucinated " +
    "generic text)? If yes, vision is working. If the reply is empty, " +
    "generic, or ignores the image, the model/mmproj pairing is broken.",
  );
}

main().catch((err) => {
  console.error("[smoke-test] ERROR:", err);
  process.exit(1);
});

// CLI runner: node run.js <tableau-views-url> "<question>"
// Streams steps to stdout, prints the final answer + session id.
// Requires: the backend running (npm run dev) and GEMINI_API_KEY in the
// repo-root .env (the VLM is a hosted endpoint, see backend/config.json).
import "./src/env.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./src/perception.js";
import { runSession } from "./src/orchestrator.js";
import { normalizeTableauViewUrl } from "./src/tableauUrl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));

const [, , vizUrlRaw, question] = process.argv;
if (!vizUrlRaw || !question) {
  console.error('Usage: node run.js <tableau-url> "<question>"');
  process.exit(1);
}
// Tableau Public shows /app/profile/<p>/viz/<wb>/<view> in the address bar, so
// that is the URL a user copies - but only /views/<wb>/<view> embeds. Both
// return 200, so an un-rewritten browse URL just burns the 90s open timeout.
const { url: vizUrl, rewritten } = normalizeTableauViewUrl(vizUrlRaw);
if (rewritten) console.log(`Rewrote browse URL to embed form: ${vizUrl}`);

function onEvent(evt) {
  switch (evt.type) {
    case "session_started":
      console.log(`\n=== Session ${evt.sessionId} ===`);
      console.log(`Dashboard: ${evt.dashboardUrl}`);
      console.log(`Question: ${evt.question}\n`);
      break;
    case "step_started":
      console.log(`--- step ${evt.idx} ---`);
      break;
    case "thought":
      console.log(`  thought: ${evt.text}`);
      break;
    case "step":
      console.log(`  action:  ${evt.action ? JSON.stringify(evt.action) : "(none - invalid response)"}`);
      console.log(`  status:  ${evt.action_status}${evt.error_msg ? ` (${evt.error_msg})` : ""}`);
      break;
    case "warning":
      console.log(`  [warning] ${evt.kind}`);
      break;
    case "session_done":
      console.log(`\n=== session done: ${evt.status} ===`);
      if (evt.error) console.log(`  error: ${evt.error}`);
      break;
    default:
      break;
  }
}

async function main() {
  const browser = await launchBrowser();
  try {
    const result = await runSession({
      browser,
      config,
      dashboardUrl: vizUrl,
      dashboardName: null,
      question,
      onEvent,
    });

    console.log(`\nSESSION ID: ${result.sessionId}`);
    console.log(`STATUS: ${result.status}`);
    if (result.status === "answered" || result.status === "max_steps") {
      console.log(`ANSWER: ${result.finalAnswer ?? "(none)"}`);
      if (result.confidence != null) console.log(`CONFIDENCE: ${result.confidence}`);
    } else if (result.status === "failed") {
      console.log("Model reported the question as unanswerable from this dashboard.");
    } else {
      console.log("Session ended in an error state - see steps table for detail.");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("RUN FAILED:", err);
  process.exit(1);
});

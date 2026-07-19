// Batch eval harness: runs a list of questions sequentially against one
// shared browser and writes a CSV summary. Doubles as the trajectory-
// collection tool for the research track (every run is fully persisted in
// the same SQLite DB / frames dir as any other session).
//
// Usage: node eval.js [path/to/questions.json]   (defaults to eval/questions.json)

import "./src/env.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./src/perception.js";
import { runSession } from "./src/orchestrator.js";
import * as store from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));

const questionsPath = process.argv[2] || path.join(__dirname, "eval", "questions.json");
const questions = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const browser = await launchBrowser();
  const rows = [["id", "question", "dashboard_url", "answer", "status", "steps", "duration_ms", "session_id", "error"]];

  console.log(`Running ${questions.length} questions from ${questionsPath}\n`);

  for (const [i, q] of questions.entries()) {
    const label = q.id ?? q.question.slice(0, 60);
    console.log(`[${i + 1}/${questions.length}] ${label}`);
    const startedAt = Date.now();

    let result;
    try {
      // Per-question try/catch: one crashing question must not kill the
      // batch (AGENT_PLAN.md Phase 3 acceptance: "zero crashes" at the
      // harness level, wrong answers/individual failures are fine).
      result = await runSession({
        browser,
        config,
        dashboardUrl: q.dashboard_url,
        dashboardName: null,
        question: q.question,
        onEvent: () => {}, // per-step detail already lands in the DB
      });
    } catch (err) {
      console.error(`  CRASHED: ${err.message}`);
      result = { sessionId: null, status: "crash", finalAnswer: null, confidence: null };
    }

    const durationMs = Date.now() - startedAt;
    let stepCount = 0;
    let errorMsg = "";
    if (result.sessionId) {
      stepCount = store.getSteps(result.sessionId).length;
      errorMsg = store.getSession(result.sessionId)?.error_message || "";
    }

    console.log(`  -> ${result.status} in ${stepCount} steps, ${(durationMs / 1000).toFixed(1)}s`);
    if (result.finalAnswer) console.log(`  answer: ${result.finalAnswer}`);

    rows.push([
      q.id ?? "",
      q.question,
      q.dashboard_url,
      result.finalAnswer ?? "",
      result.status,
      stepCount,
      durationMs,
      result.sessionId ?? "",
      errorMsg,
    ]);
  }

  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const outPath = path.join(__dirname, "eval", "results.csv");
  fs.writeFileSync(outPath, csv);
  console.log(`\nWrote ${outPath}`);

  const crashes = rows.slice(1).filter((r) => r[4] === "crash").length;
  console.log(`\n${questions.length} questions, ${crashes} harness-level crash(es).`);

  await browser.close();
}

main().catch((err) => {
  console.error("EVAL FAILED:", err);
  process.exit(1);
});

// Batch eval harness: runs a list of questions sequentially against one
// shared browser and writes a CSV summary. Doubles as the trajectory-
// collection tool for the research track (every run is fully persisted in
// the same SQLite DB / frames dir as any other session).
//
// Usage: node eval.js <path/to/questions.json>
//
// Accepts either a bare array of questions or { questions: [...] } with
// provenance keys alongside it (which is what eval/questions.json uses).
//
// Questions carrying an `expect` are scored automatically - see matchesExpect.
// That matters: the previous sets recorded most of their ground truth as
// "unknown", so a run could only ever prove "nothing crashed", never "nothing
// regressed". A set whose answers cannot be checked is worse than no set,
// because a green result invites treating it as evidence.

import "./src/env.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./src/perception.js";
import { runSession } from "./src/orchestrator.js";
import * as store from "./src/store.js";
import { normalizeTableauViewUrl } from "./src/tableauUrl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));

const questionsPath = process.argv[2] || path.join(__dirname, "eval", "questions.json");
if (!fs.existsSync(questionsPath)) {
  console.error(
    `No question set at ${questionsPath}\n\n` +
      "Usage: node eval.js [path/to/questions.json]   (defaults to eval/questions.json)\n" +
      'Each entry needs at least { "dashboard_url", "question" }; add "expect" to have it scored.',
  );
  process.exit(1);
}
const parsed = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
const questions = Array.isArray(parsed) ? parsed : (parsed.questions ?? []);
if (parsed.verified_on) {
  console.log(`Ground truth verified on ${parsed.verified_on}.`);
  console.log("These are third-party Tableau Public workbooks - if an author republishes,");
  console.log("the expected answers rot silently. Re-verify before trusting a green run.\n");
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// An `expect` entry is a list of requirements, ALL of which must hold:
//   "nintendo"            -> the answer must contain this substring
//   ["kennedy", "jfk"]    -> the answer must contain at least ONE of these
// Matching is case-insensitive. Returns null when the question is not scored,
// which is deliberately distinct from false - two questions in the shipped set
// have no establishable ground truth and must not be counted either way.
function matchesExpect(answer, q) {
  if (q.scored === false || !q.expect || !q.expect.length) return null;
  const hay = String(answer ?? "").toLowerCase();
  if (!hay) return false;
  return q.expect.every((req) =>
    Array.isArray(req)
      ? req.some((alt) => hay.includes(String(alt).toLowerCase()))
      : hay.includes(String(req).toLowerCase()),
  );
}

async function main() {
  const browser = await launchBrowser();
  const rows = [
    ["id", "question", "dashboard_url", "answer", "expected", "correct", "status", "steps", "duration_ms", "session_id", "error"],
  ];
  const scoreboard = { pass: 0, fail: 0, unscored: 0 };

  console.log(`Running ${questions.length} questions from ${questionsPath}\n`);

  for (const [i, q] of questions.entries()) {
    const label = q.id ?? q.question.slice(0, 60);
    console.log(`[${i + 1}/${questions.length}] ${label}`);
    const startedAt = Date.now();
    // Question files keep the dataset's URL verbatim for provenance; the
    // embed-form rewrite happens here at run time. See tableauUrl.js.
    const { url: dashboardUrl } = normalizeTableauViewUrl(q.dashboard_url);

    let result;
    try {
      // Per-question try/catch: one crashing question must not kill the
      // batch (AGENT_PLAN.md Phase 3 acceptance: "zero crashes" at the
      // harness level, wrong answers/individual failures are fine).
      result = await runSession({
        browser,
        config,
        dashboardUrl,
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

    const correct = matchesExpect(result.finalAnswer, q);
    if (correct === null) scoreboard.unscored++;
    else if (correct) scoreboard.pass++;
    else scoreboard.fail++;

    const mark = correct === null ? "  -  " : correct ? " PASS" : " FAIL";
    console.log(`  ->${mark} ${result.status} in ${stepCount} steps, ${(durationMs / 1000).toFixed(1)}s`);
    if (result.finalAnswer) console.log(`  answer: ${result.finalAnswer}`);
    if (correct === false) console.log(`  expected: ${q.expected_answer ?? JSON.stringify(q.expect)}`);

    rows.push([
      q.id ?? "",
      q.question,
      q.dashboard_url,
      result.finalAnswer ?? "",
      q.expected_answer ?? "",
      correct === null ? "unscored" : correct ? "pass" : "fail",
      result.status,
      stepCount,
      durationMs,
      result.sessionId ?? "",
      errorMsg,
    ]);
  }

  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const outPath = path.join(__dirname, "eval", "results.csv");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv);
  console.log(`\nWrote ${outPath}`);

  const STATUS_COL = rows[0].indexOf("status"); // derived, not hardcoded - the column set has moved before
  const crashes = rows.slice(1).filter((r) => r[STATUS_COL] === "crash").length;
  const scored = scoreboard.pass + scoreboard.fail;
  console.log(
    `\n${questions.length} questions, ${crashes} harness-level crash(es).\n` +
      `Accuracy: ${scoreboard.pass}/${scored} scored correct` +
      (scoreboard.unscored ? `, ${scoreboard.unscored} unscored (no establishable ground truth)` : ""),
  );
  if (scoreboard.fail > 0) {
    console.log("Failures:");
    for (const r of rows.slice(1).filter((x) => x[rows[0].indexOf("correct")] === "fail")) {
      console.log(`  ${r[0]}: got "${String(r[3]).slice(0, 70)}" / wanted "${r[4]}"`);
    }
  }

  await browser.close();
  // Non-zero exit on a real regression, so this is usable as a gate.
  if (scoreboard.fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("EVAL FAILED:", err);
  process.exit(1);
});

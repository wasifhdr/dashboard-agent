// better-sqlite3 wrapper implementing the sessions/steps schema
// (AGENT_PLAN.md 6.5). Frames are never deleted - only paths are stored here.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "agent.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  finished_at TEXT,
  dashboard_url TEXT,
  dashboard_name TEXT,
  question TEXT,
  status TEXT CHECK(status IN ('running','answered','failed','max_steps','error','stopped')),
  final_answer TEXT,
  confidence REAL,
  model_id TEXT,
  config_json TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  step_idx INTEGER,
  thought TEXT,
  discovery TEXT,
  action_json TEXT,
  action_status TEXT,
  error_msg TEXT,
  frame_raw_path TEXT,
  overlay_json TEXT,
  inventory_json TEXT,
  settle_timeout INTEGER DEFAULT 0,
  started_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, step_idx);
`);

// Migration for pre-existing DB files created before error_message existed.
// CREATE TABLE IF NOT EXISTS is a no-op on an already-existing table, so the
// column above only applies to fresh databases - this covers the rest.
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN error_message TEXT`);
} catch (e) {
  if (!String(e.message).includes("duplicate column")) throw e;
}

// Migration for pre-existing DB files whose CHECK constraint predates the
// 'stopped' status. SQLite cannot ALTER a CHECK constraint, so the table is
// rebuilt inside a transaction when the constraint is out of date.
const sessionsTableDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`).get();
if (sessionsTableDef && !sessionsTableDef.sql.includes("'stopped'")) {
  // steps.session_id REFERENCES sessions(id), so dropping sessions with FK
  // enforcement on fails even though the rename preserves every id. FK
  // pragma changes are only honored outside an active transaction.
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  const rebuildSessionsTable = db.transaction(() => {
    db.exec(`
      CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        created_at TEXT,
        finished_at TEXT,
        dashboard_url TEXT,
        dashboard_name TEXT,
        question TEXT,
        status TEXT CHECK(status IN ('running','answered','failed','max_steps','error','stopped')),
        final_answer TEXT,
        confidence REAL,
        model_id TEXT,
        config_json TEXT,
        error_message TEXT
      );
      INSERT INTO sessions_new SELECT * FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  });
  rebuildSessionsTable();
  db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
}

// Migration for the multi-turn "live conversation" feature (docs/LIVE_TAKEOVER_PLAN.md
// section 4). A conversation groups multiple turns (sessions rows) on one persistent
// dashboard; a takeover records what a human manually changed between turns.
// conversations/takeovers are brand-new tables, so CREATE TABLE IF NOT EXISTS covers
// fresh + pre-existing DBs alike. The two new sessions columns use the same guarded
// ALTER TABLE idiom as error_message above.
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  created_at   TEXT,
  closed_at    TEXT,
  dashboard_url  TEXT,
  dashboard_name TEXT,
  status       TEXT CHECK(status IN ('active','closed')),
  model_id     TEXT,
  config_json  TEXT
);
`);

try {
  db.exec(`ALTER TABLE sessions ADD COLUMN conversation_id TEXT`);
} catch (e) {
  if (!String(e.message).includes("duplicate column")) throw e;
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN turn_index INTEGER`);
} catch (e) {
  if (!String(e.message).includes("duplicate column")) throw e;
}

try {
  db.exec(`ALTER TABLE steps ADD COLUMN discovery TEXT`);
} catch (e) {
  if (!String(e.message).includes("duplicate column")) throw e;
}

db.exec(`
CREATE TABLE IF NOT EXISTS takeovers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    TEXT REFERENCES conversations(id),
  after_turn_index   INTEGER,
  started_at         TEXT,
  ended_at           TEXT,
  before_frame_path  TEXT,
  after_frame_path   TEXT,
  before_inventory_json TEXT,
  after_inventory_json  TEXT,
  event_log_json     TEXT,
  summary_json       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_takeovers_conversation ON takeovers(conversation_id, after_turn_index);
`);

export function createSession({
  id,
  dashboard_url,
  dashboard_name,
  question,
  model_id,
  config_json,
  conversation_id = null,
  turn_index = null,
}) {
  db.prepare(
    `INSERT INTO sessions (id, created_at, dashboard_url, dashboard_name, question, status, model_id, config_json, conversation_id, turn_index)
     VALUES (@id, @created_at, @dashboard_url, @dashboard_name, @question, 'running', @model_id, @config_json, @conversation_id, @turn_index)`,
  ).run({
    id,
    created_at: new Date().toISOString(),
    dashboard_url,
    dashboard_name: dashboard_name ?? null,
    question,
    model_id,
    config_json,
    conversation_id,
    turn_index,
  });
}

export function insertStep(step) {
  db.prepare(
    `INSERT INTO steps (session_id, step_idx, thought, discovery, action_json, action_status, error_msg, frame_raw_path, overlay_json, inventory_json, settle_timeout, started_at, duration_ms)
     VALUES (@session_id, @step_idx, @thought, @discovery, @action_json, @action_status, @error_msg, @frame_raw_path, @overlay_json, @inventory_json, @settle_timeout, @started_at, @duration_ms)`,
  ).run(step);
}

export function finishSession(id, { status, final_answer, confidence, error_message }) {
  db.prepare(
    `UPDATE sessions SET status = @status, final_answer = @final_answer, confidence = @confidence, finished_at = @finished_at, error_message = @error_message WHERE id = @id`,
  ).run({
    id,
    status,
    final_answer: final_answer ?? null,
    confidence: confidence ?? null,
    finished_at: new Date().toISOString(),
    error_message: error_message ?? null,
  });
}

export function getSession(id) {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function getSteps(id) {
  return db.prepare(`SELECT * FROM steps WHERE session_id = ? ORDER BY step_idx`).all(id);
}

export function listSessions(limit = 50) {
  return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// Legacy standalone sessions only (conversation_id IS NULL) - i.e. turns that
// were never part of a conversation (created before Phase B0, or by any
// future caller that bypasses the conversation endpoints). Used by the
// History screen (docs/LIVE_TAKEOVER_PLAN.md Phase B3) to merge with
// listConversationsWithSummary() without re-fetching turns that already
// belong to a listed conversation. listSessions() above is unchanged and
// still returns every sessions row (conversations' turns included) for
// existing callers like GET /api/sessions.
export function listStandaloneSessions(limit = 50) {
  return db
    .prepare(`SELECT * FROM sessions WHERE conversation_id IS NULL ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
}

export function latestStep1ForDashboard(dashboardUrl) {
  return db
    .prepare(
      `SELECT steps.frame_raw_path AS frame_raw_path, steps.inventory_json AS inventory_json
       FROM steps
       JOIN sessions ON sessions.id = steps.session_id
       WHERE sessions.dashboard_url = ? AND steps.step_idx = 1
       ORDER BY sessions.created_at DESC
       LIMIT 1`,
    )
    .get(dashboardUrl);
}

export function latestAnsweredSessionId(dashboardUrl) {
  const row = db
    .prepare(
      `SELECT id FROM sessions WHERE dashboard_url = ? AND status = 'answered' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(dashboardUrl);
  return row?.id ?? null;
}

export function createConversation({ id, dashboard_url, dashboard_name, model_id, config_json }) {
  db.prepare(
    `INSERT INTO conversations (id, created_at, dashboard_url, dashboard_name, status, model_id, config_json)
     VALUES (@id, @created_at, @dashboard_url, @dashboard_name, 'active', @model_id, @config_json)`,
  ).run({
    id,
    created_at: new Date().toISOString(),
    dashboard_url,
    dashboard_name: dashboard_name ?? null,
    model_id,
    config_json,
  });
}

export function closeConversation(id) {
  db.prepare(`UPDATE conversations SET status = 'closed', closed_at = @closed_at WHERE id = @id`).run({
    id,
    closed_at: new Date().toISOString(),
  });
}

export function getConversation(id) {
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
}

export function listConversations(limit = 50) {
  return db.prepare(`SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// Same rows as listConversations() plus per-conversation summary fields for
// the History screen (docs/LIVE_TAKEOVER_PLAN.md Phase B3), computed via
// correlated subqueries against sessions so the caller doesn't have to fetch
// every conversation's turns just to show a row (avoids an N+1 fetch from the
// frontend). This is a small local demo database (at most a handful of
// conversations, each with a handful of turns), so a few correlated
// subqueries per row is plenty - not worth a JOIN+GROUP BY here.
// last_turn_at is the created_at of the most recent turn (null for a
// zero-turn conversation) - History.jsx sorts/displays by this, falling back
// to the conversation's own created_at, so a conversation doesn't look stale
// just because it was first opened a while ago (review fix).
export function listConversationsWithSummary(limit = 50) {
  return db
    .prepare(
      `SELECT
         c.*,
         (SELECT COUNT(*) FROM sessions s WHERE s.conversation_id = c.id) AS turn_count,
         (SELECT s.question FROM sessions s WHERE s.conversation_id = c.id ORDER BY s.turn_index DESC LIMIT 1) AS last_question,
         (SELECT s.final_answer FROM sessions s WHERE s.conversation_id = c.id ORDER BY s.turn_index DESC LIMIT 1) AS last_answer,
         (SELECT s.status FROM sessions s WHERE s.conversation_id = c.id ORDER BY s.turn_index DESC LIMIT 1) AS last_status,
         (SELECT s.created_at FROM sessions s WHERE s.conversation_id = c.id ORDER BY s.turn_index DESC LIMIT 1) AS last_turn_at
       FROM conversations c
       ORDER BY c.created_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

export function getConversationTurns(conversationId) {
  return db.prepare(`SELECT * FROM sessions WHERE conversation_id = ? ORDER BY turn_index`).all(conversationId);
}

export function getTakeovers(conversationId) {
  return db
    .prepare(`SELECT * FROM takeovers WHERE conversation_id = ? ORDER BY after_turn_index`)
    .all(conversationId);
}

export function insertTakeover(takeover) {
  return db
    .prepare(
      `INSERT INTO takeovers (conversation_id, after_turn_index, started_at, ended_at, before_frame_path, after_frame_path, before_inventory_json, after_inventory_json, event_log_json, summary_json)
       VALUES (@conversation_id, @after_turn_index, @started_at, @ended_at, @before_frame_path, @after_frame_path, @before_inventory_json, @after_inventory_json, @event_log_json, @summary_json)`,
    )
    .run(takeover);
}

export default db;

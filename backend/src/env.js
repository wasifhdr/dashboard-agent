// Loads the project-root .env (one level above backend/) exactly once, before
// any module reads process.env. Imported first by every entry point
// (server.js, run.js, eval.js). Safe if .env is absent — dotenv silently
// no-ops. The key VALUE is never logged; only presence matters downstream.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/env.js -> ../../ == project root (dashboard-agent/)
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

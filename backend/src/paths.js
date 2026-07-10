import path from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(BACKEND_ROOT, "data");
export const FRAMES_DIR = path.join(DATA_DIR, "frames");

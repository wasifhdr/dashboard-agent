import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Proxying /api and /frames to the backend means the frontend can use plain
// relative URLs (including for EventSource/SSE) with no CORS to think about.
//
// The port is read from backend/config.json rather than duplicated here, so
// moving the backend is a one-line change on that side. Windows reserves whole
// TCP ranges for Hyper-V/WSL (`netsh interface ipv4 show excludedportrange
// protocol=tcp`) and a bind inside one fails with EACCES — 8788 died that way
// in 8720-8819, and 8990 later landed in 8921-9020. See README.md for the
// permanent fix; BACKEND_PORT is the per-run escape hatch.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendConfig = JSON.parse(
  readFileSync(path.join(__dirname, "..", "backend", "config.json"), "utf-8")
);
const BACKEND = `http://127.0.0.1:${
  Number(process.env.BACKEND_PORT) || backendConfig.backendPort || 8990
}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep a single React instance across pre-bundled deps (e.g. @gsap/react's
  // useGSAP hook) so hooks don't trip the "more than one copy of React" guard.
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { include: ["gsap", "@gsap/react"] },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        // Proxy WebSocket upgrades too, for the live-view channel at
        // /api/conversations/:id/live (Phase B1). SSE keeps working as before.
        ws: true,
      },
      "/frames": {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
});

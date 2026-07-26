import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Proxying /api and /frames to the backend means the frontend can use plain
// relative URLs (including for EventSource/SSE) with no CORS to think about.
// Backend port must stay outside Windows' Hyper-V/WSL reserved TCP ranges
// (`netsh interface ipv4 show excludedportrange protocol=tcp`) — a bind inside
// one silently "succeeds" but never listens. 8788 landed in 8720-8819; 8990 is clear.
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
        target: "http://127.0.0.1:8990",
        changeOrigin: true,
        // Proxy WebSocket upgrades too, for the live-view channel at
        // /api/conversations/:id/live (Phase B1). SSE keeps working as before.
        ws: true,
      },
      "/frames": {
        target: "http://127.0.0.1:8990",
        changeOrigin: true,
      },
    },
  },
});

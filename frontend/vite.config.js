import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Proxying /api and /frames to the backend means the frontend can use plain
// relative URLs (including for EventSource/SSE) with no CORS to think about.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
      "/frames": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});

import { defineConfig } from "vite";

const dashboardDevPort = Number(process.env.CLIPROXY_DASHBOARD_DEV_PORT ?? 60949);

export default defineConfig({
  root: "frontend",
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${dashboardDevPort}`,
        changeOrigin: false,
      },
    },
  },
});

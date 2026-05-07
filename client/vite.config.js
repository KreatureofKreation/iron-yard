import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, host: true },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          three:  ["three"],
          rapier: ["@dimforge/rapier3d-compat"],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});

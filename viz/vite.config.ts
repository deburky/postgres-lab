import { resolve } from "node:path";
import { defineConfig } from "vite";

// Relative base so the built bundle works from any path (GitHub Pages, a subfolder, file://).
// Two pages: the search city (index.html) and the job queue (queue.html).
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), queue: resolve(__dirname, "queue.html") } },
  },
});

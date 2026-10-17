import { resolve } from "node:path";
import { defineConfig } from "vite";

// Relative base so the built bundle works from any path (GitHub Pages, a subfolder, file://).
// Three pages: the search city (index.html), the job queue (queue.html) and the SQL console
// (sql.html), whose Postgres (PGlite) runs in an ES module worker.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), queue: resolve(__dirname, "queue.html"), sql: resolve(__dirname, "sql.html") } },
  },
  worker: { format: "es" },
  // PGlite loads its .wasm and data bundle relative to its own module; pre-bundling would break that
  optimizeDeps: { exclude: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"] },
});

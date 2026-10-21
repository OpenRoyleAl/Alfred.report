import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

// Build settings only; bindings, routes and exports live in cloudflare.config.ts.
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export default defineConfig({
  publicDir: root("public"),
  resolve: {
    alias: {
      pg: root("src/lib/stubs/empty-pg.ts"),
      "@electric-sql/pglite": root("src/lib/stubs/empty-pglite.ts"),
    },
  },
  plugins: [cloudflare()],
});

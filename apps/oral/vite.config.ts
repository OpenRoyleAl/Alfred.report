import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// Bindings, routes and exports live in cloudflare.config.ts; this file holds build settings only.
export default defineConfig({
  plugins: [react(), cloudflare()],
});

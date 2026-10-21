import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Build settings only; bindings, triggers and exports live in cloudflare.config.ts.
export default defineConfig({ plugins: [cloudflare()] });

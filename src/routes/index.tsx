import { createFileRoute } from "@tanstack/react-router";
import { BRAND } from "@/brand";

export const Route = createFileRoute("/")({ component: Home });

/** Local preview shell only. The product UI is served by the Worker (src/index.ts + public/). */
function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>{BRAND.platformBrand}</h1>
      <p>{BRAND.tagline}</p>
      <p>
        The Worker serves the product at <code>/</code>. Run <code>npm run dev:web</code> for the Worker.
      </p>
    </main>
  );
}

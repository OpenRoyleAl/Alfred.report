import { routeAgentRequest } from "agents";
import { AlfredOral } from "./server";
import { agentNameAllowed, identify } from "./identity";
import { instanceBrand, wakeWord } from "../../../src/brand.ts";

export { AlfredOral };

// Every request needs a verified Cloudflare Access sign-in (Access also guards oral.<domain> at
// the edge). Agent sockets may only open the caller's own tenant instance.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = await identify(request, env);
    if (!id) return new Response("Sign in required", { status: 401 });

    if (url.pathname === "/api/whoami") {
      return Response.json({ tenant: id.tenant, isOwner: id.isOwner, brand: instanceBrand(env.DOMAIN), wakeWord: wakeWord(env.DOMAIN) });
    }
    const guard = (_req: Request, route: { name: string }) =>
      agentNameAllowed(route.name, id) ? undefined : new Response("Forbidden", { status: 403 });
    const routed = await routeAgentRequest(request, env, { onBeforeConnect: guard, onBeforeRequest: guard });
    if (routed) return routed;
    if (url.pathname.startsWith("/agents/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

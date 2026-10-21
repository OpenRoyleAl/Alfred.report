import { RESOURCES } from "../brand.ts";

/** The instance's AI Gateway id (config CLOUDFLARE_GATEWAY_ID; default from src/brand.ts). */
export function gatewayId(env: { CLOUDFLARE_GATEWAY_ID?: string }): string {
  return (env.CLOUDFLARE_GATEWAY_ID || RESOURCES.gateway).trim();
}

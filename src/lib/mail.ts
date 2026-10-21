import PostalMime from "postal-mime";
import type { Env } from "./env";
import { BRAND, brandContext } from "../brand";
import { isOwnerEmail, tenantFromEmail } from "./access";

export async function ensureMailSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS kiss_mail (
        id TEXT PRIMARY KEY,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT,
        created_at INTEGER NOT NULL
      )`
    )
    .run();
}

export interface InboundEmail {
  from: string;
  to: string;
  headers: Headers;
  raw?: ReadableStream<Uint8Array>;
  setReject?: (reason: string) => void;
}

/**
 * The sender is authenticated when the receiving MTA recorded a DMARC (or DKIM) pass for it.
 * Email Routing adds the Authentication-Results header; without a pass a forged From is ignored.
 */
export function senderAuthenticated(headers: Headers): boolean {
  const ar = (headers.get("authentication-results") || "").toLowerCase();
  return /\bdmarc=pass\b/.test(ar) || /\bdkim=pass\b/.test(ar);
}

/**
 * Inbound mail (Email Routing -> this Worker). Every message is logged and acknowledged.
 * A forward from an authenticated OWNER_EMAILS sender becomes a mission in the owner's tenant.
 */
export async function handleInboundEmail(message: InboundEmail, env: Env): Promise<void> {
  const subject = message.headers.get("subject") || "(no subject)";
  const spam = parseFloat(message.headers.get("x-cf-spamh-score") || "0");
  if (spam > 8 && message.setReject) {
    message.setReject("rejected");
    return;
  }

  if (env.DB) {
    await ensureMailSchema(env.DB);
    await env.DB.prepare("INSERT INTO kiss_mail (id, from_addr, to_addr, subject, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), message.from, message.to, subject.slice(0, 300), Date.now())
      .run();
  }

  const brand = brandContext(env);
  let reply = `${brand.instanceBrand} has this.`;
  const owner = isOwnerEmail(env, message.from) && senderAuthenticated(message.headers);
  if (owner && message.raw) {
    try {
      const parsed = await PostalMime.parse(message.raw);
      const body = (parsed.text || "").slice(0, 60_000);
      const tenant = tenantFromEmail(message.from);
      const stub = env.ALFRED.getByName(tenant);
      await stub.bind(tenant, true);
      const { missionId } = await stub.missionFromEmail(subject, body);
      reply = `${brand.instanceBrand} started mission ${missionId}. You will get The Report when it closes.`;
    } catch (err) {
      console.error("owner email -> mission failed", err);
      reply = `${brand.instanceBrand} received this but could not start a mission; it is logged.`;
    }
  }

  if (!env.EMAIL?.send || !env.DOMAIN) return;
  try {
    await env.EMAIL.send({
      from: { name: brand.instanceBrand, email: `${BRAND.senderLocalPart}@${env.DOMAIN}` },
      to: message.from,
      subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
      text: `${reply}\n\n${brand.byline}`,
    });
  } catch (err) {
    console.error("reply send failed", err);
  }
}

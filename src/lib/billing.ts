/**
 * Alfred.report! signup billing: domain at cost + $99/mo (USD USA / GBP elsewhere).
 * Domain is held for the customer at signup, then transferred to their CF account when humming.
 */
import type { Env } from "./env";
import { secretGet } from "./secret";

export const ALFRED_PRICE_USD = "price_1UIO3pS0NJaOBwm44jFvbhKN";
export const ALFRED_PRICE_GBP = "price_1UIO3pS0NJaOBwm4DCeHmG4L";

/** Rough at-cost defaults when registrar does not return a price (cents). */
const DOMAIN_COST_CENTS: Record<string, number> = {
  report: 1200,
  com: 1200,
  net: 1400,
  org: 1400,
  io: 4500,
  ai: 7000,
  me: 2000,
  co: 1200,
  uk: 900,
  "co.uk": 900,
};

async function stripeKey(env: Env): Promise<string | null> {
  const k = (await secretGet(env.STRIPE_SECRET_KEY)) || (await secretGet(env.STRIPE_KEY));
  return typeof k === "string" && k.length > 8 ? k : null;
}

export function currencyForCountry(country?: string | null): "usd" | "gbp" {
  const c = (country || "").toUpperCase();
  if (c === "US" || c === "USA" || c === "UM") return "usd";
  return "gbp";
}

export function subscriptionPriceId(currency: "usd" | "gbp", env: Env): string {
  if (currency === "usd") return env.STRIPE_PRICE_USD_99 || ALFRED_PRICE_USD;
  return env.STRIPE_PRICE_GBP_99 || ALFRED_PRICE_GBP;
}

export function normalizeDomainInput(raw: string): { ok: true; domain: string; label: string; tld: string } | { ok: false; error: string } {
  let s = (raw || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!s) return { ok: false, error: "Domain required" };
  // bare handle → .report
  if (!s.includes(".")) s = `${s}.report`;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s)) {
    return { ok: false, error: "Invalid domain" };
  }
  const parts = s.split(".");
  const label = parts[0];
  const tld = parts.slice(1).join(".");
  if (label.length < 2) return { ok: false, error: "Name too short" };
  return { ok: true, domain: s, label, tld };
}

export async function checkDomainAvailability(
  env: Env,
  raw: string
): Promise<{
  ok: boolean;
  domain?: string;
  available?: boolean;
  supported_tld?: boolean;
  cost_cents?: number;
  currency_hint?: string;
  mode: "live" | "heuristic";
  error?: string;
  hold_note?: string;
}> {
  const norm = normalizeDomainInput(raw);
  if (!norm.ok) return { ok: false, error: norm.error, mode: "heuristic" };

  const token = (await secretGet(env.CF_API_TOKEN)) || (await secretGet(env.CLOUDFLARE_API_TOKEN));
  const account = (await secretGet(env.CF_ACCOUNT_ID)) || (env.CLOUDFLARE_ACCOUNT_ID || "");
  let available: boolean | undefined;
  let supported = true;
  let mode: "live" | "heuristic" = "heuristic";

  if (token && account) {
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/registrar/domains/${encodeURIComponent(norm.domain)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j = (await r.json()) as {
        success?: boolean;
        result?: { available?: boolean; supported_tld?: boolean; name?: string };
      };
      if (j.success && j.result) {
        mode = "live";
        available = j.result.available;
        supported = j.result.supported_tld !== false;
      }
    } catch {
      /* fall through */
    }
  }

  if (available === undefined) {
    // Heuristic: known taken marketing names only; do not fake a hold.
    const reserved = new Set(["alfred.report", "www.report", "oral.report", "openroyleal.report"]);
    available = !reserved.has(norm.domain);
    mode = "heuristic";
  }

  const cost =
    DOMAIN_COST_CENTS[norm.tld] ??
    DOMAIN_COST_CENTS[norm.tld.split(".").pop() || ""] ??
    1500;

  return {
    ok: true,
    domain: norm.domain,
    available,
    supported_tld: supported,
    cost_cents: cost,
    currency_hint: "charged in checkout currency",
    mode,
    hold_note:
      "At signup we register/hold this domain so nobody else buys it, then transfer it into your Cloudflare account when humming — no lock-in.",
  };
}

export async function createCheckoutSession(
  env: Env,
  opts: {
    domain: string;
    email?: string;
    handle?: string;
    country?: string;
    successUrl: string;
    cancelUrl: string;
    domainCostCents: number;
  }
): Promise<{ ok: true; url: string; session_id: string } | { ok: false; error: string; status: number }> {
  const key = await stripeKey(env);
  if (!key) {
    return { ok: false, error: "Billing not configured", status: 503 };
  }

  const currency = currencyForCountry(opts.country);
  const priceId = subscriptionPriceId(currency, env);
  const domainCents = Math.max(0, Math.round(opts.domainCostCents));

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", opts.successUrl);
  params.set("cancel_url", opts.cancelUrl);
  params.set("allow_promotion_codes", "true");
  params.set("billing_address_collection", "auto");
  params.set("client_reference_id", opts.handle || opts.domain);
  if (opts.email) params.set("customer_email", opts.email);
  params.set("metadata[product]", "alfred-report");
  params.set("metadata[domain]", opts.domain);
  params.set("metadata[handle]", opts.handle || "");
  params.set("metadata[domain_hold]", "pending_transfer_to_customer_cf");
  params.set("subscription_data[metadata][product]", "alfred-report");
  params.set("subscription_data[metadata][domain]", opts.domain);
  // Line 0: recurring Alfred.report!
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  // Line 1: domain at cost (one-time)
  if (domainCents > 0) {
    params.set("line_items[1][price_data][currency]", currency);
    params.set("line_items[1][price_data][unit_amount]", String(domainCents));
    params.set("line_items[1][price_data][product_data][name]", `Domain hold: ${opts.domain}`);
    params.set(
      "line_items[1][price_data][product_data][description]",
      "At-cost domain registration/hold. Transferred to your Cloudflare account when setup is humming. No lock-in."
    );
    params.set("line_items[1][quantity]", "1");
  }

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const j = (await r.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!r.ok || !j.url || !j.id) {
    return { ok: false, error: j.error?.message || "Checkout failed", status: 502 };
  }
  return { ok: true, url: j.url, session_id: j.id };
}


/** Mark kiss_users.billing_paid when Checkout completes (email from session). */
export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const key = await stripeKey(env);
  if (!key) return Response.json({ error: "Billing not configured" }, { status: 503 });
  const body = await req.text();
  // Signature verify optional when secret missing (dev); prefer secret in prod
  const whsec = await secretGet(env.STRIPE_WEBHOOK_SECRET);
  if (whsec) {
    const sig = req.headers.get("stripe-signature") || "";
    if (!sig) return Response.json({ error: "missing signature" }, { status: 400 });
    // Lightweight timestamp + v1 HMAC check (Stripe style)
    const parts = Object.fromEntries(
      sig.split(",").map((p) => {
        const [k, v] = p.split("=");
        return [k, v];
      })
    ) as Record<string, string>;
    const ts = parts.t;
    const v1 = parts.v1;
    if (!ts || !v1) return Response.json({ error: "bad signature header" }, { status: 400 });
    const enc = new TextEncoder();
    const keyBytes = await crypto.subtle.importKey(
      "raw",
      enc.encode(whsec),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signed = await crypto.subtle.sign("HMAC", keyBytes, enc.encode(`${ts}.${body}`));
    const hex = [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== v1) {
      // Stripe may send multiple v1; accept if any match
      const allV1 = sig
        .split(",")
        .filter((p) => p.startsWith("v1="))
        .map((p) => p.slice(3));
      if (!allV1.includes(hex)) {
        return Response.json({ error: "invalid signature" }, { status: 400 });
      }
    }
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const obj = event.data?.object || {};
    const details = obj.customer_details as { email?: string } | undefined;
    const email = String(obj.customer_email || details?.email || "")
      .toLowerCase()
      .trim();
    const meta = (obj.metadata || {}) as { domain?: string; handle?: string };
    if (email) {
      try {
        await env.DB.prepare(
          `UPDATE kiss_users SET billing_paid = 1 WHERE email = ?`
        )
          .bind(email)
          .run();
      } catch {
        /* schema may lag */
      }
      try {
        await env.DB.prepare(
          `INSERT INTO kiss_billing_events (id, email, domain, handle, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
          .bind(
            String(obj.id || crypto.randomUUID()),
            email,
            meta.domain || "",
            meta.handle || "",
            String(obj.id || ""),
            Math.floor(Date.now() / 1000)
          )
          .run();
      } catch {
        /* optional table */
      }
    }
  }
  return Response.json({ received: true });
}

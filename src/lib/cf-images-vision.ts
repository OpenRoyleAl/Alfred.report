/**
 * Cloudflare Images — always-on vision token prep.
 *
 * Workers path: env.IMAGES binding (transform in-flight, no storage quota).
 * Variant target: visionprep — mobile-first aggressive scale-down (≤512 edge).
 * Multimodal providers bill by image tiles/tokens (grows with resolution), not
 * "free pixels". Keep edge small; LLMs only OCR/reason on prepped JPEGs.
 *
 * Paid CF Images storage ($5/100k stored) is optional — Workers IMAGES binding
 * transforms in-flight without the storage add-on.
 */

import type { Env } from "./env";

export const CF_IMAGES_HASH = "qylTSKAhkLl75P5qa0ChGw";
export const CF_IMAGES_VARIANT = "visionprep";
/** Longest edge (px). Mobile-first; ~¼ of old 1280 desk default. */
export const VISION_MAX_EDGE = 512;
/** JPEG quality after scale-down — favor tokens over print fidelity. */
export const VISION_JPEG_QUALITY = 72;

/** Minimal OpenAI-style multimodal message (content may be string or parts). */
export type VisionMessage = {
  role: string;
  content: unknown;
};

export type VisionPrepMeta = {
  prepared: number;
  skipped: number;
  failed: number;
  via: "images-binding" | "passthrough" | "none";
};

type ImageBinding = {
  info: (stream: ReadableStream) => Promise<{ format?: string; width?: number; height?: number; fileSize?: number }>;
  input: (stream: ReadableStream) => {
    transform: (opts: {
      width?: number;
      height?: number;
      fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
    }) => {
      output: (opts: { format?: string; quality?: number }) => Promise<{
        response: () => Response;
        image: () => ReadableStream;
      }>;
    };
  };
};

function getImages(env: Env): ImageBinding | null {
  const img = (env as Env & { IMAGES?: ImageBinding }).IMAGES;
  return img && typeof img.input === "function" ? img : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchImageBytes(src: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const s = String(src || "").trim();
  if (!s) return null;

  if (/^data:image\//i.test(s)) {
    const m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) return null;
    const bin = atob(m[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, contentType: m[1].toLowerCase() };
  }

  if (/^https?:\/\//i.test(s)) {
    // Already a CF Images visionprep delivery URL — leave as-is.
    if (/imagedelivery\.net\//i.test(s) && /\/visionprep(?:\?|$)/i.test(s)) {
      return null; // signal skip
    }
    try {
      const res = await fetch(s, {
        headers: { Accept: "image/*,*/*", "User-Agent": "Alfred-Report-VisionPrep/1.0" },
        redirect: "follow",
      });
      if (!res.ok) return null;
      const ct = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const ab = await res.arrayBuffer();
      return { bytes: new Uint8Array(ab), contentType: ct || "image/jpeg" };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Transform raw image bytes via Workers Images binding → JPEG data URL ≤512 edge.
 */
export async function prepImageBytesWithBinding(
  env: Env,
  bytes: Uint8Array,
  _contentType?: string,
): Promise<string | null> {
  const images = getImages(env);
  if (!images) return null;

  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const out = await images
      .input(stream)
      .transform({
        width: VISION_MAX_EDGE,
        height: VISION_MAX_EDGE,
        fit: "scale-down",
      })
      .output({ format: "image/jpeg", quality: VISION_JPEG_QUALITY });
    const res = out.response();
    const ab = await res.arrayBuffer();
    const outBytes = new Uint8Array(ab);
    const b64 = bytesToBase64(outBytes);
    return `data:image/jpeg;base64,${b64}`;
  } catch (err) {
    console.warn("[cf-images-vision] binding transform failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function prepOneSource(env: Env, src: string): Promise<{ url: string; changed: boolean; failed: boolean }> {
  const original = String(src || "");
  if (!original) return { url: original, changed: false, failed: false };

  // Already CF visionprep delivery
  if (/imagedelivery\.net\//i.test(original) && /\/visionprep(?:\?|$)/i.test(original)) {
    return { url: original, changed: false, failed: false };
  }

  const fetched = await fetchImageBytes(original);
  if (fetched === null && /^https?:\/\//i.test(original) && /imagedelivery\.net\//i.test(original)) {
    return { url: original, changed: false, failed: false };
  }
  if (!fetched) {
    // Could not load — keep original (URL may still work for the vision model)
    return { url: original, changed: false, failed: true };
  }

  const prepped = await prepImageBytesWithBinding(env, fetched.bytes, fetched.contentType);
  if (!prepped) {
    // No binding or transform fail — keep original bytes as data URL if we have them
    if (/^data:image\//i.test(original)) return { url: original, changed: false, failed: true };
    const b64 = bytesToBase64(fetched.bytes);
    const ct = fetched.contentType.startsWith("image/") ? fetched.contentType : "image/jpeg";
    return { url: `data:${ct};base64,${b64}`, changed: true, failed: true };
  }
  return { url: prepped, changed: true, failed: false };
}

function rewriteImageUrlField(obj: Record<string, unknown>, newUrl: string): void {
  if (obj.image_url && typeof obj.image_url === "object" && obj.image_url !== null) {
    (obj.image_url as Record<string, unknown>).url = newUrl;
  } else if (typeof obj.image_url === "string") {
    obj.image_url = newUrl;
  } else if (typeof obj.url === "string") {
    obj.url = newUrl;
  }
}

function extractImageSrc(part: Record<string, unknown>): string | null {
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url === "object") {
    const u = (part.image_url as { url?: string }).url;
    return typeof u === "string" ? u : null;
  }
  if (typeof part.url === "string" && (part.type === "image" || part.type === "image_url")) return part.url;
  return null;
}

/**
 * Walk multimodal messages and prep every image through Cloudflare Images.
 * Always prefer CF; never use an LLM for resize.
 */
export async function prepareMessagesForVision(
  env: Env,
  messages: VisionMessage[],
): Promise<{ messages: VisionMessage[]; meta: VisionPrepMeta }> {
  const images = getImages(env);
  const meta: VisionPrepMeta = {
    prepared: 0,
    skipped: 0,
    failed: 0,
    via: images ? "images-binding" : "passthrough",
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    meta.via = "none";
    return { messages, meta };
  }

  const out: VisionMessage[] = [];
  for (const msg of messages) {
    const content = msg?.content;
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }

    const parts: unknown[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        parts.push(part);
        continue;
      }
      const p = { ...(part as Record<string, unknown>) };
      const type = String(p.type || "");
      const src = extractImageSrc(p);
      if (!(type === "image_url" || type === "image" || src)) {
        parts.push(p);
        continue;
      }
      if (!src) {
        parts.push(p);
        meta.skipped += 1;
        continue;
      }

      const result = await prepOneSource(env, src);
      if (result.failed && !result.changed) meta.failed += 1;
      else if (result.changed && result.failed) {
        meta.failed += 1;
        meta.prepared += 1;
      } else if (result.changed) meta.prepared += 1;
      else meta.skipped += 1;

      rewriteImageUrlField(p, result.url);
      if (p.type === "image" && !p.image_url) {
        p.type = "image_url";
        p.image_url = { url: result.url };
      }
      parts.push(p);
    }
    out.push({ ...msg, content: parts });
  }

  return { messages: out, meta };
}

/** JSON body helper for /api/vision-prep */
export async function handleVisionPrepRequest(req: Request, env: Env): Promise<Response> {
  let body: { messages?: VisionMessage[]; image?: string; images?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (Array.isArray(body.messages) && body.messages.length) {
    const { messages, meta } = await prepareMessagesForVision(env, body.messages);
    return Response.json({ ok: true, messages, meta });
  }

  const list: string[] = [];
  if (typeof body.image === "string") list.push(body.image);
  if (Array.isArray(body.images)) {
    for (const u of body.images) if (typeof u === "string") list.push(u);
  }
  if (!list.length) {
    return Response.json({ ok: false, error: "need messages or image(s)" }, { status: 400 });
  }

  const prepared: string[] = [];
  let failed = 0;
  for (const src of list) {
    const r = await prepOneSource(env, src);
    prepared.push(r.url);
    if (r.failed) failed += 1;
  }
  return Response.json({
    ok: true,
    images: prepared,
    meta: {
      prepared: prepared.length,
      failed,
      via: getImages(env) ? "images-binding" : "passthrough",
    },
  });
}

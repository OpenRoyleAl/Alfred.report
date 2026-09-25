/**
 * Google Business Profile integration.
 * Service account with domain-wide delegation (JWT bearer grant).
 * Credentials come from env / Secrets Store — never hardcode keys here.
 */

import type { Env } from "./env";

// ─── Types ────────────────────────────────────────────────────

export interface GBPLocation {
  id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  rating: number;
  reviews: number;
  status: string;
  placeId?: string;
  mapsUri?: string;
  categories?: string[];
}

export interface GBPReview {
  reviewId: string;
  author: string;
  rating: number;
  text: string;
  createTime: string;
  updateTime: string;
  profilePhoto: string;
  reply: string | null;
  replyTime: string;
}

export interface GBPPost {
  title: string;
  text: string;
  url: string;
  image: string;
  createTime: string;
  topicType: string;
}

export interface GBPKeyword {
  keyword: string;
  count: number;
}

export interface GBPReviewsData {
  location: GBPLocation;
  reviews: GBPReview[];
  averageRating: number;
  totalReviewCount: number;
  starDistribution: Record<number, number>;
  reviewVelocity: { month: string; count: number }[];
  posts: GBPPost[];
  keywords: GBPKeyword[];
}

// ─── Service Account Auth (JWT Bearer Grant) ──────────────────

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

// In-memory token cache
let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM headers/footers and decode
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signJWT(sa: ServiceAccountKey, subject: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
    sub: subject,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

async function getServiceAccountToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const saJson = env.GOOGLE_SA_KEY;
  if (!saJson) throw new Error("GOOGLE_SA_KEY not configured");

  const sa: ServiceAccountKey = JSON.parse(saJson);
  const subject = env.GBP_SUBJECT || "hans@icebergmedia.co.uk";
  const scope = "https://www.googleapis.com/auth/business.manage";

  const assertion = await signJWT(sa, subject, scope);

  const response = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SA token exchange failed: ${response.status} ${body}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return cachedToken.token;
}

// ─── GBP API Helpers ──────────────────────────────────────────

const ACCOUNT_ID = "104324010804696626128";

async function gbpGet(url: string, token: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GBP GET ${url} → ${response.status} ${body.slice(0, 500)}`);
  }
  return response.json();
}

// ─── Public API ───────────────────────────────────────────────

export async function fetchGBPLocations(env: Env): Promise<GBPLocation[]> {
  try {
    const token = await getServiceAccountToken(env);
    const readMask = "name,title,storefrontAddress,metadata,phoneNumbers,websiteUri,categories";
    const url = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${ACCOUNT_ID}/locations?readMask=${readMask}&pageSize=100`;
    const data = await gbpGet(url, token);

    return (data.locations || []).map((loc: any) => {
      const addr = loc.storefrontAddress || {};
      const parts = [...(addr.addressLines || []), addr.locality, addr.administrativeArea, addr.postalCode].filter(Boolean);
      const cats = loc.categories || {};
      const primary = cats.primaryCategory?.displayName || "";
      const additional = (cats.additionalCategories || []).map((c: any) => c.displayName).filter(Boolean);

      return {
        id: (loc.name || "").split("/").pop(),
        name: loc.title || "Unknown",
        address: parts.join(", "),
        phone: loc.phoneNumbers?.primaryPhone || "",
        website: loc.websiteUri || "",
        rating: 0,
        reviews: 0,
        status: "active",
        placeId: loc.metadata?.placeId || "",
        mapsUri: loc.metadata?.mapsUri || "",
        categories: [primary, ...additional].filter(Boolean),
      };
    });
  } catch (error) {
    console.error("GBP locations fetch error:", error);
    return [];
  }
}

export async function fetchGBPReviews(env: Env, locationId: string): Promise<GBPReviewsData> {
  const token = await getServiceAccountToken(env);

  // Fetch location details
  const locUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${locationId}?readMask=name,title,storefrontAddress,metadata,phoneNumbers,websiteUri,categories`;
  let location: GBPLocation;
  try {
    const loc = await gbpGet(locUrl, token);
    const addr = loc.storefrontAddress || {};
    const parts = [...(addr.addressLines || []), addr.locality, addr.administrativeArea, addr.postalCode].filter(Boolean);
    location = {
      id: locationId,
      name: loc.title || "Unknown",
      address: parts.join(", "),
      phone: loc.phoneNumbers?.primaryPhone || "",
      website: loc.websiteUri || "",
      rating: 0,
      reviews: 0,
      status: "active",
      placeId: loc.metadata?.placeId || "",
      mapsUri: loc.metadata?.mapsUri || "",
    };
  } catch {
    location = { id: locationId, name: "Unknown", address: "", phone: "", website: "", rating: 0, reviews: 0, status: "active" };
  }

  // Fetch reviews (v4 API)
  const ratingMap: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  let reviews: GBPReview[] = [];
  let averageRating = 0;
  let totalReviewCount = 0;

  try {
    const revUrl = `https://mybusiness.googleapis.com/v4/accounts/${ACCOUNT_ID}/locations/${locationId}/reviews?pageSize=50`;
    let data = await gbpGet(revUrl, token);
    averageRating = Number(data.averageRating || 0);
    totalReviewCount = Number(data.totalReviewCount || 0);

    const addPage = (payload: any) => {
      for (const r of payload.reviews || []) {
        reviews.push({
          reviewId: r.reviewId || r.name || "",
          author: r.reviewer?.displayName || "Google user",
          rating: ratingMap[r.starRating?.replace("STAR_RATING_", "")] || 0,
          text: r.comment || "",
          createTime: r.createTime || "",
          updateTime: r.updateTime || "",
          profilePhoto: r.reviewer?.profilePhotoUrl || "",
          reply: r.reviewReply?.comment || null,
          replyTime: r.reviewReply?.updateTime || "",
        });
      }
    };

    addPage(data);
    while (data.nextPageToken) {
      data = await gbpGet(`${revUrl}&pageToken=${encodeURIComponent(data.nextPageToken)}`, token);
      addPage(data);
    }
  } catch (error) {
    console.error("GBP reviews fetch error:", error);
  }

  // Star distribution
  const starDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    if (r.rating >= 1 && r.rating <= 5) starDistribution[r.rating]++;
  }

  // Review velocity (reviews per month, last 12 months)
  const monthCounts: Record<string, number> = {};
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthCounts[key] = 0;
  }
  for (const r of reviews) {
    if (r.createTime) {
      const d = new Date(r.createTime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (key in monthCounts) monthCounts[key]++;
    }
  }
  const reviewVelocity = Object.entries(monthCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));

  // Fetch GBP posts
  let posts: GBPPost[] = [];
  try {
    const postsUrl = `https://mybusiness.googleapis.com/v4/accounts/${ACCOUNT_ID}/locations/${locationId}/localPosts?pageSize=20`;
    const postsData = await gbpGet(postsUrl, token);
    for (const p of postsData.localPosts || []) {
      if ((p.state || "").toUpperCase() !== "LIVE") continue;
      const media = p.media || [];
      posts.push({
        title: (p.topicType || "STANDARD").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        text: p.summary || "",
        url: p.callToAction?.url || "",
        image: media[0]?.googleUrl || "",
        createTime: p.createTime || "",
        topicType: p.topicType || "STANDARD",
      });
    }
  } catch (error) {
    console.error("GBP posts fetch error:", error);
  }

  // Extract keywords from reviews (simple word frequency)
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
    "is", "was", "are", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "shall", "can", "it", "its", "this", "that",
    "these", "those", "i", "we", "you", "he", "she", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "our", "their", "not", "no", "so", "if", "then", "than", "too", "very",
    "just", "about", "up", "out", "all", "from", "been", "were", "said", "each", "which", "their",
    "time", "would", "there", "what", "when", "who", "how", "more", "some", "also", "into",
  ]);

  const wordCounts: Record<string, number> = {};
  for (const r of reviews) {
    const words = (r.text || "").toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
    for (const w of words) {
      if (w.length > 2 && !stopWords.has(w)) {
        wordCounts[w] = (wordCounts[w] || 0) + 1;
      }
    }
  }

  const keywords: GBPKeyword[] = Object.entries(wordCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 30)
    .map(([keyword, count]) => ({ keyword, count }));

  return {
    location,
    reviews,
    averageRating,
    totalReviewCount,
    starDistribution,
    reviewVelocity,
    posts,
    keywords,
  };
}

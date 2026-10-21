/**
 * CF changelog/blog watch — runs ON Cloudflare (Worker cron).
 * Sources: developers.cloudflare.com/changelog RSS + blog.cloudflare.com/rss
 * Owner wake only when material to Workers AI / AI Gateway / Agents (and close kin).
 */

import type { KVNamespace } from "@cloudflare/workers-types";
import { ownerWake, type A2AEnv } from "./a2a";

const CHANGELOG_RSS = "https://developers.cloudflare.com/changelog/rss/index.xml";
const BLOG_RSS = "https://blog.cloudflare.com/rss/";
const KV_KEY = "cf_changelog_watch:v1";

/** Titles/descriptions that matter to Alfred.report. */
const MATERIAL_RE =
  /\b(workers?\s*ai|ai\s*gateway|agents?(?:\s+sdk)?|durable\s*objects?|workflows?|vectorize|workers?\b|wrangler|mcp|browser\s*rendering|containers?\b|python\s*workers?)\b/i;

export interface CfChangelogEnv extends A2AEnv {
  CONFIG: KVNamespace;
}

export interface CfFeedItem {
  source: "changelog" | "blog";
  title: string;
  link: string;
  guid: string;
  pubDate?: string;
  description?: string;
}

export interface CfChangelogState {
  seen_guids: string[];
  last_run_at: number;
  last_material: Array<{ title: string; link: string; at: number }>;
}

export interface CfChangelogResult {
  ok: boolean;
  fetched: number;
  new_items: number;
  material: CfFeedItem[];
  woke: boolean;
  wake_skipped?: boolean;
  detail?: string;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseRssItems(xml: string, source: "changelog" | "blog"): CfFeedItem[] {
  const items: CfFeedItem[] = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const block of blocks.slice(0, 40)) {
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "").trim();
    const link = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1] || "").trim();
    const guid =
      (block.match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/i)?.[1] || "").trim() ||
      link ||
      title;
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim();
    const description = stripTags(
      block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] || ""
    );
    if (!title && !link) continue;
    items.push({ source, title, link, guid, pubDate: pubDate || undefined, description });
  }
  return items;
}

function isMaterial(item: CfFeedItem): boolean {
  const hay = `${item.title}\n${item.description || ""}\n${item.link}`;
  return MATERIAL_RE.test(hay);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "User-Agent": "AlfredReport-cf-changelog-watch/1.0",
    },
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}

export async function runCfChangelogWatch(env: CfChangelogEnv): Promise<CfChangelogResult> {
  let changelogXml: string;
  let blogXml: string;
  try {
    [changelogXml, blogXml] = await Promise.all([fetchText(CHANGELOG_RSS), fetchText(BLOG_RSS)]);
  } catch (e) {
    return {
      ok: false,
      fetched: 0,
      new_items: 0,
      material: [],
      woke: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  const items = [
    ...parseRssItems(changelogXml, "changelog"),
    ...parseRssItems(blogXml, "blog"),
  ];

  const raw = await env.CONFIG.get(KV_KEY);
  const state: CfChangelogState = raw
    ? (JSON.parse(raw) as CfChangelogState)
    : { seen_guids: [], last_run_at: 0, last_material: [] };

  const seen = new Set(state.seen_guids);
  const fresh = items.filter((i) => i.guid && !seen.has(i.guid));
  // First run: seed seen set, do not wake on historical backlog
  const firstRun = state.seen_guids.length === 0;
  const material = firstRun ? [] : fresh.filter(isMaterial);

  for (const i of items) {
    if (i.guid) seen.add(i.guid);
  }
  // Cap retention
  const seen_guids = [...seen].slice(-500);
  const last_material = [
    ...material.map((m) => ({ title: m.title, link: m.link, at: Date.now() })),
    ...(state.last_material || []),
  ].slice(0, 20);

  await env.CONFIG.put(
    KV_KEY,
    JSON.stringify({
      seen_guids,
      last_run_at: Date.now(),
      last_material,
      first_seed: firstRun,
    } satisfies CfChangelogState & { first_seed?: boolean })
  );

  let woke = false;
  let wake_skipped = false;
  if (material.length > 0) {
    const preview = material
      .slice(0, 5)
      .map((m) => `• ${m.title} (${m.source}) ${m.link}`)
      .join("\n");
    const wake = await ownerWake(env, {
      reason: "cf_changelog_material",
      preview: `CF material updates (${material.length}):\n${preview}`.slice(0, 900),
      objective: "CF changelog/blog material to Workers AI / Gateway / Agents",
    });
    woke = Boolean(wake.ok);
    wake_skipped = Boolean(wake.skipped);
  }

  return {
    ok: true,
    fetched: items.length,
    new_items: firstRun ? 0 : fresh.length,
    material,
    woke,
    wake_skipped: material.length ? wake_skipped : undefined,
    detail: firstRun ? "seeded_seen_no_wake" : undefined,
  };
}

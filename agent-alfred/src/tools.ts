import type { AiSearchNamespace } from "../../src/types";
import { createBrowserTools, type BrowserBinding } from "./browser";

export function createAISearchTool(aiSearch: AiSearchNamespace, instanceName = "alfred-kb") {
  return {
    name: "search_knowledge_base",
    description: "Search alfred-kb for grounded facts from alfred.report.",
    async execute(query: string, filter?: Record<string, string>) {
      const instance = aiSearch.get(instanceName);
      const results = await instance.search({
        query,
        filter,
        ai_search_options: { retrieval: { max_num_results: 5 } },
      } as any);
      const chunks = results?.chunks || results?.data || results;
      if (Array.isArray(chunks)) {
        return chunks.map((chunk: any) => chunk.text || chunk.content || JSON.stringify(chunk)).join("\n\n");
      }
      return results;
    },
  };
}

export function createPaymentsTool(env: {
  DB: D1Database;
  WALLET_HANDLE?: string;
}) {
  return {
    name: "authorize_spend",
    description: "Authorize an agentic payment against a mission budget. Cloudflare Wallets are early access — this records intent and enforces budget, it does not move funds.",
    async execute(input: { missionId?: string; amountUsd: number; purpose: string; url?: string }) {
      const handle = env.WALLET_HANDLE || "alfred";
      if (!input.amountUsd || input.amountUsd <= 0) {
        return { authorized: false, reason: "amountUsd must be positive" };
      }

      let budget: number | null = null;
      let spent = 0;
      if (input.missionId) {
        const mission = await env.DB.prepare(`SELECT budget_usd FROM missions WHERE id = ?`).bind(input.missionId).first<{ budget_usd: number | null }>();
        budget = mission?.budget_usd ?? null;
        const row = await env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM cost_events WHERE mission_id = ?`).bind(input.missionId).first<{ spent: number }>();
        spent = row?.spent ?? 0;
        if (budget !== null && spent + input.amountUsd > budget) {
          return {
            authorized: false,
            reason: `Budget exceeded: spent ${spent.toFixed(4)} + ${input.amountUsd} > ${budget}`,
            wallet: `${handle}.cloudflare.pay`,
            fundsLive: false,
          };
        }
      }

      return {
        authorized: true,
        status: "intent_recorded",
        amountUsd: input.amountUsd,
        purpose: input.purpose,
        url: input.url || null,
        wallet: `${handle}.cloudflare.pay`,
        fundsLive: false,
        note: "Cloudflare Wallets early access: handle reservation only. No send/receive until GA.",
        budget,
        spent,
      };
    },
  };
}

export function createOralTools(env: {
  BROWSER: BrowserBinding;
  AI_SEARCH: AiSearchNamespace;
  DB: D1Database;
  WALLET_HANDLE?: string;
}) {
  const browser = createBrowserTools(env.BROWSER);
  const search = createAISearchTool(env.AI_SEARCH);
  const payments = createPaymentsTool(env);
  return { browser, search, payments };
}

export const WORKERS_AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Search the alfred-kb knowledge base before answering factual questions about Alfred or alfred.report.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Focused search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_markdown",
      description: "Fetch a public web page and return it as markdown.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_extract",
      description: "Extract structured facts from a public web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          instructions: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "authorize_spend",
      description: "Authorize a paid crawl or tool purchase against the mission budget.",
      parameters: {
        type: "object",
        properties: {
          missionId: { type: "string" },
          amountUsd: { type: "number" },
          purpose: { type: "string" },
          url: { type: "string" },
        },
        required: ["amountUsd", "purpose"],
      },
    },
  },
];

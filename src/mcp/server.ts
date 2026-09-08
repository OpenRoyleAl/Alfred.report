// src/mcp/server.ts — MCP 2026-07-28 stateless endpoint (WebMCP-style)
import type { Env } from "../types";
import { recordCop, recordCostEvent } from "../cop/cop";

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ jsonrpc: string; method: string; params?: any; id?: string | number }>();
  switch (body.method) {
    case "initialize":
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "alfred", version: "2.0.0" } } });
    case "tools/list":
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [
        { name: "create_mission", description: "Create a new Alfred mission", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "integer", minimum: 1, maximum: 10 } }, required: ["title"] } },
        { name: "query_missions", description: "List missions with optional status filter", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "active", "completed", "failed"] } } } },
        { name: "get_report", description: "Get a mission report", inputSchema: { type: "object", properties: { missionId: { type: "string" } }, required: ["missionId"] } },
        { name: "speak", description: "Send text to Alfred via TTS", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      ] } });
    case "tools/call":
      return handleToolCall(body, env);
    default:
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }
}

async function handleToolCall(body: any, env: Env): Promise<Response> {
  const { name, arguments: args } = body.params;
  switch (name) {
    case "create_mission": {
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO missions (id, user_id, title, description, status, priority, created_at, updated_at) VALUES (?, 'mcp', ?, ?, 'pending', ?, datetime('now'), datetime('now'))`).bind(id, args.title, args.description || null, args.priority || 5).run();
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `Mission created: ${id}` }] } });
    }
    case "query_missions": {
      const status = args?.status;
      const query = status ? `SELECT id, title, status, priority, created_at FROM missions WHERE status = ? ORDER BY created_at DESC LIMIT 20` : `SELECT id, title, status, priority, created_at FROM missions ORDER BY created_at DESC LIMIT 20`;
      const stmt = env.DB.prepare(query);
      const result = status ? await stmt.bind(status).all() : await stmt.all();
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result.results, null, 2) }] } });
    }
    case "get_report": {
      const report = await env.ALFRED_REPORT.fetch(`https://alfred-report/internal/report/${args.missionId}`);
      const data = await report.json();
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] } });
    }
    case "speak": {
      const start = Date.now();
      await env.AI.run("@cf/deepgram/aura-2-en", { text: args.text });
      const durationMs = Date.now() - start;
      const tokensOut = Math.ceil(args.text.length / 4);
      recordCop(env, {
        userId: "mcp",
        missionId: "mcp",
        agent: "mcp",
        provider: "workers-ai",
        model: "@cf/deepgram/aura-2-en",
        eventType: "tts",
        tokensOut,
        durationMs,
      });
      await recordCostEvent(env, {
        missionId: null,
        userId: "mcp",
        agent: "mcp",
        provider: "workers-ai",
        model: "@cf/deepgram/aura-2-en",
        eventType: "tts",
        tokensOut,
        durationMs,
      });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Speech synthesized" }] } });
    }
    default:
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  }
}
// src/a2a/agent-card.ts — A2A agent card (discovery)
import type { Env } from "../types";

export function handleAgentCard(env: Env): Response {
  return Response.json({
    name: "Alfred",
    description: "OpenRoyleAl oral operator. Product: Alfred.report. Wake word: Alfred, report!",
    url: "https://alfred.report",
    provider: { organization: "OpenRoyleAl" },
    version: "2.0.0",
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text", "voice"],
    defaultOutputModes: ["text", "voice", "json"],
    skills: [
      { id: "oral_operator", name: "ORAL Operator", description: "Execute bounded missions with typed evidence" },
      { id: "voice_interaction", name: "Voice Interaction", description: "Real-time voice via WebSocket (Workers AI TTS/STT)" },
      { id: "report_generation", name: "Report Generation", description: "Generate structured reports from mission data" },
    ],
    authentication: { type: "cloudflare-access", serviceToken: true },
  }, { headers: { "Content-Type": "application/json" } });
}
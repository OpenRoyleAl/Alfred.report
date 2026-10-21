import { Agent } from "agents";
import * as db from "../lib/db";
import { createChatClient } from "../lib/llm";
import { FARMER_SYSTEM } from "../prompts";
import type { WorkerResult } from "../types";
import type { Env } from "./curator";

export interface FarmerState {
  lastRunAt: number;
  totalLeads: number;
  totalOutreach: number;
}

// ─── Farmer Agent ───────────────────────────────────────────────

export class Farmer extends Agent<Env, FarmerState> {
  initialState = { lastRunAt: 0, totalLeads: 0, totalOutreach: 0 };

  /**
   * Scan for growth opportunities: identify leads, flag at-risk clients,
   * generate outreach tasks.
   */
  async scanForOpportunities(): Promise<WorkerResult> {
    const start = Date.now();
    const errors: string[] = [];
    let recordsCreated = 0;

    const matters = await db.getRecordsByType(this.env.DB, "matter", 50);
    const orgs = await db.getRecordsByType(this.env.DB, "org", 50);
    const commitments = await db.getRecordsByType(this.env.DB, "commitment", 50);

    const llm = createChatClient(this.env);

    const analysis = await llm.chatJSON<{
      leads: Array<{ org_name: string; reason: string; priority: string; metadata?: Record<string, unknown> }>;
      at_risk: Array<{ matter_id: string; reason: string; action: string }>;
      outreach: Array<{ target_org: string; channel: string; message_draft: string; metadata?: Record<string, unknown> }>;
    }>(
      [
        { role: "system", content: FARMER_SYSTEM },
        {
          role: "user",
          content: `Analyze the current state and identify growth opportunities.

Active matters (${matters.length}):
${matters.map((m) => `- ${m.id}: ${m.title}`).join("\n")}

Organizations (${orgs.length}):
${orgs.map((o) => `- ${o.id}: ${o.title}`).join("\n")}

Open commitments (${commitments.length}):
${commitments.map((c) => `- ${c.id}: ${c.title}`).join("\n")}

Return JSON:
{
  "leads": [{ "org_name": "...", "reason": "...", "priority": "high|medium|low" }],
  "at_risk": [{ "matter_id": "...", "reason": "...", "action": "..." }],
  "outreach": [{ "target_org": "...", "channel": "email|linkedin|phone", "message_draft": "..." }]
}`,
        },
      ],
      { temperature: 0.6, max_tokens: 4096 }
    );

    // Create lead records
    for (const lead of analysis.leads ?? []) {
      const record = await db.createRecord(this.env.DB, {
        type: "note",
        title: `Lead: ${lead.org_name}`,
        content: lead.reason,
        metadata: { category: "lead", priority: lead.priority, ...lead.metadata },
      });
      recordsCreated++;
      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `Farmer identified lead: ${lead.org_name} (${lead.priority})`,
        source: "farmer",
        confidence: 0.7,
      });
    }

    // Flag at-risk clients
    for (const risk of analysis.at_risk ?? []) {
      await db.createObservation(this.env.DB, {
        record_id: risk.matter_id,
        signal: `Farmer flagged at-risk: ${risk.reason}. Action: ${risk.action}`,
        source: "farmer",
        confidence: 0.8,
      });
      await db.createRecord(this.env.DB, {
        type: "task",
        title: `Follow up: ${risk.reason}`,
        content: risk.action,
        metadata: { matter_id: risk.matter_id, category: "retention" },
      });
      recordsCreated++;
    }

    // Create outreach commitments
    for (const outreach of analysis.outreach ?? []) {
      const record = await db.createRecord(this.env.DB, {
        type: "commitment",
        title: `Outreach: ${outreach.target_org} via ${outreach.channel}`,
        content: outreach.message_draft,
        metadata: { channel: outreach.channel, target: outreach.target_org, ...outreach.metadata },
      });
      recordsCreated++;
      await db.createObservation(this.env.DB, {
        record_id: record.id,
        signal: `Farmer created outreach commitment: ${outreach.target_org}`,
        source: "farmer",
        confidence: 0.9,
      });
    }

    this.setState({
      lastRunAt: Date.now(),
      totalLeads: this.state.totalLeads + (analysis.leads?.length ?? 0),
      totalOutreach: this.state.totalOutreach + (analysis.outreach?.length ?? 0),
    });

    return {
      worker: "farmer",
      success: errors.length === 0,
      summary: `Found ${analysis.leads?.length ?? 0} leads, ${analysis.at_risk?.length ?? 0} at-risk clients, ${analysis.outreach?.length ?? 0} outreach actions`,
      recordsCreated,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Generate a specific outreach message for a target organization.
   */
  async generateOutreach(targetOrg: string, channel: string, context: string): Promise<string> {
    const llm = createChatClient(this.env);
    const message = await llm.chat(
      [
        { role: "system", content: FARMER_SYSTEM },
        {
          role: "user",
          content: `Write a ${channel} outreach message to ${targetOrg}.
Context: ${context}

The message should be:
- Personalized and specific to their business
- Focused on SEO value, not generic
- Short (under 150 words for email, under 300 chars for LinkedIn)
- Professional but not stiff

Return only the message text, no explanation.`,
        },
      ],
      { temperature: 0.7, max_tokens: 500 }
    );

    return message.trim();
  }
}

/** Pi extension "clairic": typed extraction (email / voice transcript / image) into mission fields. */
import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { extractMission, type ClairicEnv, type IntakeSource } from "../clairic.ts";

const Params = Type.Object({
  source: Type.Union([Type.Literal("email"), Type.Literal("voice"), Type.Literal("image")]),
  text: Type.Optional(Type.String({ maxLength: 60000, description: "Email body or voice transcript (or image caption)." })),
  subject: Type.Optional(Type.String({ maxLength: 500 })),
  image_base64: Type.Optional(Type.String({ description: "Base64 PNG/JPEG/WebP (no remote URLs)." })),
  content_type: Type.Optional(Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")])),
});

export type Extract = typeof extractMission;

export function clairicExtension(env: ClairicEnv, extract: Extract = extractMission): Extension {
  const tool: ToolRegistration<typeof Params> = {
    name: "extract_mission_fields",
    description:
      "Pull typed fields (objective, client, due date/time, amount+currency, duration, people) out of an email, " +
      "a voice transcript or an image. Fields listed in needsReview are uncertain: confirm them with the owner.",
    parameters: Params,
    replay: "safe",
    async execute(p) {
      let src: IntakeSource;
      if (p.source === "image") {
        if (!p.image_base64) return { output: [{ type: "text", text: "image_base64 is required for source=image" }], isError: true };
        src = { kind: "image", caption: p.text, images: [{ content_type: p.content_type ?? "image/png", base64: p.image_base64 }] };
      } else if (p.source === "email") {
        src = { kind: "email", subject: p.subject, body: p.text ?? "" };
      } else {
        src = { kind: "voice", transcript: p.text ?? "" };
      }
      try {
        const r = await extract(env, src);
        return { output: [{ type: "text", text: JSON.stringify({ fields: r.fields, needsReview: r.needsReview, truncated: r.truncated }) }] };
      } catch (err) {
        return { output: [{ type: "text", text: `extraction failed: ${(err as Error).message}` }], isError: true };
      }
    },
  };
  return {
    name: "clairic",
    tools: [tool] as unknown as ToolRegistration[],
    sections: [{ key: "clairic", render: () => "Clairic: use extract_mission_fields on forwarded emails, voice transcripts and images; confirm needsReview fields with the owner." }],
  };
}

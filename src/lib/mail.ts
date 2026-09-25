import type { Env } from "./env";

const FROM = "al@alfred.report";

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

/** Inbound: Email Routing → this Worker. Outbound: send as al@alfred.report. */
export async function handleInboundEmail(
  message: {
    from: string;
    to: string;
    headers: Headers;
    setReject?: (reason: string) => void;
  },
  env: Env
): Promise<void> {
  const subject = message.headers.get("subject") || "(no subject)";
  const spam = parseFloat(message.headers.get("x-cf-spamh-score") || "0");
  if (spam > 8 && message.setReject) {
    message.setReject("rejected");
    return;
  }

  if (env.DB) {
    await ensureMailSchema(env.DB);
    await env.DB.prepare(
      "INSERT INTO kiss_mail (id, from_addr, to_addr, subject, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), message.from, message.to, subject.slice(0, 300), Date.now())
      .run();
  }

  if (!env.EMAIL?.send) return;
  try {
    await env.EMAIL.send({
      from: { name: "Alfred", email: FROM },
      to: message.from,
      subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
      text: "Alfred.report has this. al@alfred.report — OpenRoyleAl.",
    });
  } catch (err) {
    console.error("al@ send failed", err);
  }
}

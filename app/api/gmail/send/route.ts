import { after, NextRequest, NextResponse } from "next/server";
import { scheduleBackgroundAgent } from "@/lib/agents/background";
import { recordAudit } from "@/lib/audit";
import { currentUser } from "@/lib/auth";
import { query } from "@/lib/db";

function encodeBase64Url(str: string): string {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  const sessionUser = await currentUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing Gmail access token." },
      { status: 401 },
    );
  }

  let body: {
    to?: string;
    subject?: string;
    message?: string;
    threadId?: string;
    inReplyTo?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const to = sanitizeHeader(body.to ?? "");
  const subject = sanitizeHeader(body.subject ?? "");
  const message = (body.message ?? "").trim();

  if (!to || !subject || !message) {
    return NextResponse.json(
      { error: "Recipient, subject, and message body are required." },
      { status: 400 },
    );
  }

  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (body.inReplyTo) {
    const cleanReplyId = sanitizeHeader(body.inReplyTo);
    lines.push(`In-Reply-To: ${cleanReplyId}`);
    lines.push(`References: ${cleanReplyId}`);
  }
  lines.push("", message);

  const raw = encodeBase64Url(lines.join("\r\n"));
  const payload: { raw: string; threadId?: string } = { raw };
  if (body.threadId) payload.threadId = body.threadId;

  const sendRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    },
  );

  if (sendRes.status === 401) {
    return NextResponse.json(
      { error: "Gmail session expired. Please reconnect your Gmail account." },
      { status: 401 },
    );
  }

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    return NextResponse.json(
      { error: `Failed to send email: ${errText.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const sent = (await sendRes.json()) as { id?: string; threadId?: string };

  await recordAudit({
    actor: sessionUser.email,
    orgId: sessionUser.orgId,
    action: "GMAIL_SENT",
    entityType: "communication",
    entityId: sent.id ?? null,
    after: { to, subject, threadId: sent.threadId ?? null },
  });

  try {
    await query(
      `INSERT INTO communications
          (shipment_id, contact_id, channel, direction, body, recipient, state, safety_checked)
       VALUES ($1, $2, 'EMAIL', 'OUTBOUND', $3, $4, 'SENT', true)`,
      [null, null, `${subject}: ${message.slice(0, 500)}`, to],
    );
  } catch {
    // Non-fatal communications log
  }

  after(() => {
    scheduleBackgroundAgent({
      workflow: "communications.proactive_outreach",
      orgId: sessionUser.orgId,
      actorEmail: sessionUser.email,
      task: `Verify outbound customer email follow-up alignment for subject "${subject.slice(0, 120)}".`,
      workKind: "gmail.outbound_sync",
      cooldownMs: 180_000,
    });
  });

  return NextResponse.json({
    ok: true,
    id: sent.id,
    threadId: sent.threadId,
  });
}

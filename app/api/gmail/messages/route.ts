import { after, NextRequest, NextResponse } from "next/server";
import { currentUser, may } from "@/lib/auth";
import { detectWorkspaceTampering, hasDepartmentAccess } from "@/lib/tenant-guard";

type GmailHeader = { name?: string; value?: string };
type GmailMessagePayload = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
};

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const match = headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return match?.value ?? "";
}

export async function GET(req: NextRequest) {
  const sessionUser = await currentUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const tamper = detectWorkspaceTampering(req, sessionUser.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  if (
    !hasDepartmentAccess(sessionUser, "SUPPORT") &&
    !hasDepartmentAccess(sessionUser, "CUSTOMERS")
  ) {
    return NextResponse.json(
      { error: "Your account is not authorized to access workspace communications." },
      { status: 403 },
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing Gmail access token." },
      { status: 401 },
    );
  }

  const [profileRes, listRes] = await Promise.all([
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: authHeader },
      cache: "no-store",
    }),
    fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=8&q=in:inbox",
      {
        headers: { Authorization: authHeader },
        cache: "no-store",
      },
    ),
  ]);

  if (profileRes.status === 401 || listRes.status === 401) {
    return NextResponse.json(
      { error: "Gmail session expired. Please sign in with Google again." },
      { status: 401 },
    );
  }

  if (!profileRes.ok || !listRes.ok) {
    const errText = await (profileRes.ok ? listRes : profileRes).text();
    return NextResponse.json(
      { error: `Gmail API error: ${errText.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const profile = (await profileRes.json()) as {
    emailAddress?: string;
    messagesTotal?: number;
    threadsTotal?: number;
  };
  const listData = (await listRes.json()) as {
    messages?: { id: string; threadId: string }[];
  };

  const stubs = listData.messages ?? [];
  const messages = await Promise.all(
    stubs.slice(0, 8).map(async (m) => {
      const detailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
        {
          headers: { Authorization: authHeader },
          cache: "no-store",
        },
      );
      if (!detailRes.ok) {
        return {
          id: m.id,
          threadId: m.threadId,
          from: "",
          subject: "(Unable to load message)",
          date: "",
          snippet: "",
          unread: false,
        };
      }
      const msg = (await detailRes.json()) as GmailMessagePayload;
      const hdrs = msg.payload?.headers;
      return {
        id: msg.id,
        threadId: msg.threadId,
        from: headerValue(hdrs, "From"),
        subject: headerValue(hdrs, "Subject") || "(No subject)",
        date: headerValue(hdrs, "Date"),
        messageId: headerValue(hdrs, "Message-ID"),
        snippet: msg.snippet ?? "",
        unread: Boolean(msg.labelIds?.includes("UNREAD")),
      };
    }),
  );

  const unreadMessages = messages.filter((m) => m.unread);
  const canAutoTriage =
    may(sessionUser.role, "EDIT_SHIPMENT") || may(sessionUser.role, "ADMINISTER");
  if (unreadMessages.length > 0 && canAutoTriage) {
    const digest = unreadMessages
      .slice(0, 3)
      .map((m) => `${m.subject} (${m.from}): ${m.snippet.slice(0, 120)}`)
      .join(" | ");
    const { dispatchToAutonomousAgent } = await import("@/lib/agents/autonomous");
    after(async () => {
      await dispatchToAutonomousAgent({
        sourceChannel: "GMAIL",
        message: `Inbound Gmail triage: ${digest.slice(0, 600)}`,
        orgId: sessionUser.orgId,
        actorEmail: sessionUser.email,
        mode: "background_orchestrate",
      }).catch(() => {});
    });
  }

  return NextResponse.json({
    profile: {
      emailAddress: profile.emailAddress ?? "",
      messagesTotal: profile.messagesTotal ?? 0,
      threadsTotal: profile.threadsTotal ?? 0,
    },
    messages,
  });
}

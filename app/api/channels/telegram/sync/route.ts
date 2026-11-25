import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { currentUser, may } from "@/lib/auth";
import {
  ensureTelegramPollerRunning,
  syncTelegramUpdatesNow,
} from "@/lib/channels/telegram";

export const dynamic = "force-dynamic";

function verifyInternalWorkerHeader(req: NextRequest): boolean {
  const expected = (
    globalThis as typeof globalThis & { __telegramWorkerSecret?: string }
  ).__telegramWorkerSecret;
  const provided = req.headers.get("x-internal-worker-secret");
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const isInternal = verifyInternalWorkerHeader(req);
  if (isInternal) {
    ensureTelegramPollerRunning();
    const summary = await syncTelegramUpdatesNow({ longPollTimeoutSec: 0 });
    return NextResponse.json({ ok: true, mode: "worker", ...summary });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "ADMINISTER") && !may(user.role, "EDIT_SHIPMENT")) {
    return NextResponse.json(
      { error: "You are not permitted to sync channels." },
      { status: 403 },
    );
  }

  ensureTelegramPollerRunning();
  const summary = await syncTelegramUpdatesNow({
    orgId: user.orgId,
    longPollTimeoutSec: 0,
  });
  return NextResponse.json({ ok: true, mode: "manual", ...summary });
}

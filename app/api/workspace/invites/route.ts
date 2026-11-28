import { NextRequest, NextResponse } from "next/server";
import { currentUser, type Role } from "@/lib/auth";
import { isSameOriginMutation } from "@/lib/intelligence/access";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";
import {
  createTeamInvitation,
  revokeTeamInvitation,
} from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only workspace administrators can create team invitations." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const email = typeof body.email === "string" ? body.email : "";
  const role = (typeof body.role === "string" ? body.role : "DISPATCHER") as Role;
  const expiresInHours =
    typeof body.expiresInHours === "number" ? body.expiresInHours : 72;

  const result = await createTeamInvitation(user.orgId, user, {
    email,
    role,
    departments: body.departments,
    branchCodes: body.branchCodes,
    expiresInHours,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(
    {
      ok: true,
      invitation: result.invitation,
      invitePath: result.invitePath,
    },
    { status: 201 },
  );
}

export async function DELETE(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only workspace administrators can revoke team invitations." },
      { status: 403 },
    );
  }

  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const invitationId = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!invitationId) {
    return NextResponse.json({ error: "Invitation ID is required." }, { status: 400 });
  }

  const result = await revokeTeamInvitation(user.orgId, user, invitationId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

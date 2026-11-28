import { NextRequest, NextResponse } from "next/server";
import { currentUser, type Role } from "@/lib/auth";
import { isSameOriginMutation } from "@/lib/intelligence/access";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";
import {
  listTeamInvitations,
  listWorkspaceMembers,
  updateWorkspaceMember,
} from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Workspace administrator privileges are required." },
      { status: 403 },
    );
  }

  const [members, invitations] = await Promise.all([
    listWorkspaceMembers(user.orgId),
    listTeamInvitations(user.orgId),
  ]);
  return NextResponse.json({ members, invitations });
}

export async function PATCH(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Workspace administrator privileges are required." },
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

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId) {
    return NextResponse.json({ error: "Member ID is required." }, { status: 400 });
  }

  const result = await updateWorkspaceMember(user.orgId, user, userId, {
    role: typeof body.role === "string" ? (body.role as Role) : undefined,
    departments: body.departments !== undefined ? body.departments : undefined,
    branchCodes: body.branchCodes !== undefined ? body.branchCodes : undefined,
    active: typeof body.active === "boolean" ? body.active : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true, member: result.member });
}

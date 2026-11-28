import { createHash, randomBytes } from "node:crypto";
import { recordAudit } from "./audit";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  startSessionWithCookie,
  type Role,
  type SessionCookieMeta,
  type SessionUser,
} from "./auth";
import { identityQuery, queryAs } from "./db";
import {
  sealWebhookSecret,
  unsealWebhookSecret,
} from "./integrations/security";
import { claimDistributedWebhookReplay } from "./distributed-guard";
import {
  assertVerifiedOrgId,
  constantTimeTokenEqual,
  normalizeBranchCodes,
  normalizeDepartments,
  type WorkspaceDepartment,
} from "./tenant-guard";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = new Set<Role>(["VIEWER", "DISPATCHER", "APPROVER", "ADMIN"]);

export interface WorkspaceMember {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  departments: WorkspaceDepartment[];
  branchCodes: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  orgId: string;
  email: string;
  role: Role;
  departments: WorkspaceDepartment[];
  branchCodes: string[];
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
}

export interface WorkspaceSecurityProfile {
  orgId: string;
  orgName: string;
  webhookToken: string;
  intakeApiKeyPrefix: string | null;
  hasIntakeApiKey: boolean;
  whatsappPhoneNumberId: string | null;
  hasWhatsappVerifyToken: boolean;
  hasWhatsappAppSecret: boolean;
  hasTelegramWebhookSecret: boolean;
}

export interface ResolvedOrgWebhookRow {
  id: string;
  name: string;
  active: boolean;
  webhook_token: string | null;
  intake_api_key_hash: string | null;
  intake_api_key_prefix: string | null;
  whatsapp_phone_number_id: string | null;
  whatsapp_verify_token: string | null;
  whatsapp_app_secret_sealed: string | null;
  telegram_webhook_secret_hash: string | null;
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeRole(role: unknown, fallback: Role = "VIEWER"): Role {
  if (typeof role === "string" && ALLOWED_ROLES.has(role.toUpperCase() as Role)) {
    return role.toUpperCase() as Role;
  }
  return fallback;
}

function toInvitationStatus(row: {
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  expires_at: Date | string;
}): WorkspaceInvitation["status"] {
  if (row.accepted_at) return "ACCEPTED";
  if (row.revoked_at) return "REVOKED";
  if (new Date(row.expires_at).getTime() <= Date.now()) return "EXPIRED";
  return "PENDING";
}

export async function listWorkspaceMembers(orgId: string): Promise<WorkspaceMember[]> {
  assertVerifiedOrgId(orgId, "listWorkspaceMembers");
  const rows = await identityQuery<{
    id: string;
    org_id: string;
    email: string;
    name: string | null;
    role: Role;
    active: boolean;
    departments?: string[] | null;
    branch_codes?: string[] | null;
    last_login_at: Date | string | null;
    created_at: Date | string;
  }>(
    `SELECT id, org_id, email, name, role, active, departments, branch_codes,
            last_login_at, created_at
       FROM users
      WHERE org_id = $1
      ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    name: r.name,
    role: r.role,
    active: Boolean(r.active),
    departments: normalizeDepartments(r.departments),
    branchCodes: normalizeBranchCodes(r.branch_codes),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function updateWorkspaceMember(
  orgId: string,
  actor: SessionUser,
  targetUserId: string,
  patch: {
    role?: Role;
    departments?: unknown;
    branchCodes?: unknown;
    active?: boolean;
  },
): Promise<{ ok: true; member: WorkspaceMember } | { ok: false; error: string }> {
  assertVerifiedOrgId(orgId, "updateWorkspaceMember");
  if (actor.orgId !== orgId || actor.role !== "ADMIN") {
    return { ok: false, error: "Workspace administrator privileges are required." };
  }

  const members = await listWorkspaceMembers(orgId);
  const target = members.find((m) => m.id === targetUserId);
  if (!target) {
    return { ok: false, error: "Team member not found in your workspace." };
  }

  const nextRole = patch.role !== undefined ? normalizeRole(patch.role, target.role) : target.role;
  const nextActive = patch.active !== undefined ? Boolean(patch.active) : target.active;
  const nextDepartments =
    patch.departments !== undefined
      ? normalizeDepartments(patch.departments)
      : target.departments;
  const nextBranchCodes =
    patch.branchCodes !== undefined
      ? normalizeBranchCodes(patch.branchCodes)
      : target.branchCodes;

  // Prevent locking out the workspace by removing or demoting its last active ADMIN.
  const remainingAdmins = members.filter((m) => {
    if (m.id === target.id) {
      return nextActive && nextRole === "ADMIN";
    }
    return m.active && m.role === "ADMIN";
  });
  if (remainingAdmins.length === 0) {
    return {
      ok: false,
      error: "Every workspace must keep at least one active administrator.",
    };
  }

  const updated = await identityQuery<{
    id: string;
    org_id: string;
    email: string;
    name: string | null;
    role: Role;
    active: boolean;
    departments?: string[] | null;
    branch_codes?: string[] | null;
    last_login_at: Date | string | null;
    created_at: Date | string;
  }>(
    `UPDATE users SET role = $1, departments = $2, branch_codes = $3, active = $4
      WHERE id = $5 AND org_id = $6
      RETURNING id, org_id, email, name, role, active, departments, branch_codes,
                last_login_at, created_at`,
    [nextRole, nextDepartments, nextBranchCodes, nextActive, targetUserId, orgId],
  );
  if (updated.length === 0) {
    return { ok: false, error: "Unable to update team member." };
  }

  if (!nextActive) {
    await identityQuery("DELETE FROM sessions WHERE user_id = $1", [targetUserId]);
  }

  await recordAudit({
    actor: actor.email,
    actorType: "USER",
    action: nextActive ? "WORKSPACE_MEMBER_UPDATED" : "WORKSPACE_MEMBER_DEACTIVATED",
    orgId,
    entityType: `user:${target.email}`,
    before: {
      role: target.role,
      departments: target.departments,
      branchCodes: target.branchCodes,
      active: target.active,
    },
    after: {
      role: nextRole,
      departments: nextDepartments,
      branchCodes: nextBranchCodes,
      active: nextActive,
    },
  });

  const row = updated[0];
  return {
    ok: true,
    member: {
      id: row.id,
      orgId: row.org_id,
      email: row.email,
      name: row.name,
      role: row.role,
      active: Boolean(row.active),
      departments: normalizeDepartments(row.departments),
      branchCodes: normalizeBranchCodes(row.branch_codes),
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    },
  };
}

export async function listTeamInvitations(
  orgId: string,
): Promise<WorkspaceInvitation[]> {
  assertVerifiedOrgId(orgId, "listTeamInvitations");
  const rows = await queryAs<{
    id: string;
    org_id: string;
    email: string;
    role: Role;
    departments?: string[] | null;
    branch_codes?: string[] | null;
    invited_by: string | null;
    expires_at: Date | string;
    accepted_at: Date | string | null;
    revoked_at: Date | string | null;
    created_at: Date | string;
  }>(
    orgId,
    `SELECT id, org_id, email, role, departments, branch_codes, invited_by,
            expires_at, accepted_at, revoked_at, created_at
       FROM team_invitations
      ORDER BY created_at DESC`,
  );

  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    role: r.role,
    departments: normalizeDepartments(r.departments),
    branchCodes: normalizeBranchCodes(r.branch_codes),
    invitedBy: r.invited_by,
    expiresAt: new Date(r.expires_at).toISOString(),
    acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    status: toInvitationStatus(r),
  }));
}

export async function createTeamInvitation(
  orgId: string,
  inviter: SessionUser,
  input: {
    email: string;
    role: Role;
    departments?: unknown;
    branchCodes?: unknown;
    expiresInHours?: number;
  },
): Promise<
  | { ok: true; invitation: WorkspaceInvitation; inviteToken: string; invitePath: string }
  | { ok: false; error: string }
> {
  assertVerifiedOrgId(orgId, "createTeamInvitation");
  if (inviter.orgId !== orgId || inviter.role !== "ADMIN") {
    return { ok: false, error: "Only workspace administrators can invite team members." };
  }

  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid work email address." };
  }

  // Enforce single workspace per email policy up front.
  const existingUsers = await identityQuery<{ id: string }>(
    `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role
       FROM users u JOIN organisations o ON o.id = u.org_id
      WHERE lower(u.email) = lower($1)`,
    [email],
  );
  if (existingUsers.length > 0) {
    return {
      ok: false,
      error: "An account with this email already belongs to a workspace.",
    };
  }

  const role = normalizeRole(input.role, "DISPATCHER");
  const departments = role === "ADMIN" ? [] : normalizeDepartments(input.departments);
  const branchCodes = role === "ADMIN" ? [] : normalizeBranchCodes(input.branchCodes);
  const hours = Math.min(168, Math.max(1, Math.round(input.expiresInHours ?? 72)));
  const expiresAt = new Date(Date.now() + hours * 3_600_000);

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(rawToken);

  const rows = await queryAs<{
    id: string;
    org_id: string;
    email: string;
    role: Role;
    departments?: string[] | null;
    branch_codes?: string[] | null;
    invited_by: string | null;
    expires_at: Date | string;
    accepted_at: Date | string | null;
    revoked_at: Date | string | null;
    created_at: Date | string;
  }>(
    orgId,
    `INSERT INTO team_invitations
       (token_hash, email, role, departments, branch_codes, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, org_id, email, role, departments, branch_codes, invited_by,
               expires_at, accepted_at, revoked_at, created_at`,
    [tokenHash, email, role, departments, branchCodes, inviter.id, expiresAt],
  );

  const row = rows[0];
  await recordAudit({
    actor: inviter.email,
    actorType: "USER",
    action: "TEAM_INVITATION_CREATED",
    orgId,
    entityType: `invite:${email}`,
    after: { role, departments, branchCodes, expiresAt: expiresAt.toISOString() },
  });

  return {
    ok: true,
    inviteToken: rawToken,
    invitePath: `/invite/${rawToken}`,
    invitation: {
      id: row.id,
      orgId: row.org_id,
      email: row.email,
      role: row.role,
      departments: normalizeDepartments(row.departments),
      branchCodes: normalizeBranchCodes(row.branch_codes),
      invitedBy: row.invited_by,
      expiresAt: new Date(row.expires_at).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date(row.created_at).toISOString(),
      status: "PENDING",
    },
  };
}

export async function revokeTeamInvitation(
  orgId: string,
  actor: SessionUser,
  invitationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  assertVerifiedOrgId(orgId, "revokeTeamInvitation");
  if (actor.orgId !== orgId || actor.role !== "ADMIN") {
    return { ok: false, error: "Workspace administrator privileges are required." };
  }

  const rows = await queryAs<{ id: string; email: string }>(
    orgId,
    `UPDATE team_invitations SET revoked_at = now()
      WHERE id = $1
      RETURNING id, email`,
    [invitationId],
  );
  if (rows.length === 0) {
    return { ok: false, error: "Invitation not found." };
  }

  await recordAudit({
    actor: actor.email,
    actorType: "USER",
    action: "TEAM_INVITATION_REVOKED",
    orgId,
    entityType: `invite:${rows[0].email}`,
  });

  return { ok: true };
}

export interface PublicInvitationInfo {
  email: string;
  orgName: string;
  role: Role;
  departments: WorkspaceDepartment[];
  branchCodes: string[];
  expiresAt: string;
  valid: boolean;
  reason?: string;
}

export async function inspectTeamInvitation(
  rawToken: string,
): Promise<PublicInvitationInfo | null> {
  if (!rawToken || rawToken.trim().length < 16) return null;
  const tokenHash = sha256Hex(rawToken.trim());
  const rows = await identityQuery<{
    id: string;
    org_id: string;
    org_name: string;
    email: string;
    role: Role;
    departments?: string[] | null;
    branch_codes?: string[] | null;
    expires_at: Date | string;
    accepted_at: Date | string | null;
    revoked_at: Date | string | null;
  }>(
    `SELECT ti.id, ti.org_id, o.name AS org_name, ti.email, ti.role,
            ti.departments, ti.branch_codes, ti.expires_at,
            ti.accepted_at, ti.revoked_at
       FROM team_invitations ti
       JOIN organisations o ON o.id = ti.org_id
      WHERE ti.token_hash = $1 AND o.active
      LIMIT 1`,
    [tokenHash],
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  let valid = true;
  let reason: string | undefined;
  if (row.accepted_at) {
    valid = false;
    reason = "This invitation has already been accepted.";
  } else if (row.revoked_at) {
    valid = false;
    reason = "This invitation has been revoked by a workspace administrator.";
  } else if (new Date(row.expires_at).getTime() <= Date.now()) {
    valid = false;
    reason = "This invitation has expired. Ask your workspace admin for a new link.";
  }

  return {
    email: row.email,
    orgName: row.org_name,
    role: row.role,
    departments: normalizeDepartments(row.departments),
    branchCodes: normalizeBranchCodes(row.branch_codes),
    expiresAt: new Date(row.expires_at).toISOString(),
    valid,
    reason,
  };
}

export async function acceptTeamInvitation(
  rawToken: string,
  input: { name: string; password: string },
  meta: { ip?: string | null; userAgent?: string | null } = {},
  options: { startSession?: boolean } = {},
): Promise<
  | { ok: true; user: SessionUser; cookie?: SessionCookieMeta }
  | { ok: false; error: string }
> {
  if (!rawToken || rawToken.trim().length < 16) {
    return { ok: false, error: "Invalid invitation link." };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter your full name." };
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const tokenHash = sha256Hex(rawToken.trim());
  const rows = await identityQuery<{
    id: string;
    org_id: string;
    org_name: string;
    email: string;
    role: Role;
    departments?: string[] | null;
    branch_codes?: string[] | null;
    expires_at: Date | string;
    accepted_at: Date | string | null;
    revoked_at: Date | string | null;
  }>(
    `SELECT ti.id, ti.org_id, o.name AS org_name, ti.email, ti.role,
            ti.departments, ti.branch_codes, ti.expires_at,
            ti.accepted_at, ti.revoked_at
       FROM team_invitations ti
       JOIN organisations o ON o.id = ti.org_id
      WHERE ti.token_hash = $1 AND o.active
      LIMIT 1`,
    [tokenHash],
  );
  if (rows.length === 0) {
    return { ok: false, error: "This invitation link is invalid." };
  }
  const invite = rows[0];
  if (invite.accepted_at) {
    return { ok: false, error: "This invitation has already been used." };
  }
  if (invite.revoked_at) {
    return { ok: false, error: "This invitation has been revoked." };
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: "This invitation has expired." };
  }

  const passwordHash = await hashPassword(input.password);
  const departments = normalizeDepartments(invite.departments);
  const branchCodes = normalizeBranchCodes(invite.branch_codes);

  let insertedUser: {
    id: string;
    email: string;
    name: string | null;
    role: Role;
    departments?: string[] | null;
    branch_codes?: string[] | null;
  };
  try {
    const inserted = await identityQuery<{
      id: string;
      email: string;
      name: string | null;
      role: Role;
      departments?: string[] | null;
      branch_codes?: string[] | null;
    }>(
      `INSERT INTO users (org_id, email, password_hash, role, name, departments, branch_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, name, role, departments, branch_codes`,
      [
        invite.org_id,
        invite.email.toLowerCase(),
        passwordHash,
        invite.role,
        name,
        departments,
        branchCodes,
      ],
    );
    insertedUser = inserted[0];
  } catch (err) {
    const e = err as { code?: string; constraint?: string } | null;
    if (e?.code === "23505") {
      return {
        ok: false,
        error: "An account with this email already belongs to a workspace.",
      };
    }
    throw err;
  }

  await identityQuery(
    `UPDATE team_invitations SET accepted_at = now() WHERE id = $1 RETURNING id`,
    [invite.id],
  );

  await recordAudit({
    actor: insertedUser.email,
    actorType: "USER",
    action: "TEAM_INVITATION_ACCEPTED",
    orgId: invite.org_id,
    entityType: `user:${insertedUser.email}`,
    after: { role: insertedUser.role, departments, branchCodes },
  });

  if (options.startSession === false) {
    return {
      ok: true,
      user: {
        id: insertedUser.id,
        orgId: invite.org_id,
        orgName: invite.org_name,
        email: insertedUser.email,
        name: insertedUser.name,
        role: insertedUser.role,
        departments,
        branchCodes,
      },
    };
  }

  const started = await startSessionWithCookie(
    {
      id: insertedUser.id,
      org_id: invite.org_id,
      org_name: invite.org_name,
      email: insertedUser.email,
      name: insertedUser.name,
      role: insertedUser.role,
      departments,
      branch_codes: branchCodes,
    },
    meta,
  );
  return { ok: true, user: started.user, cookie: started.cookie };
}

// -------------------------------------------------- Workspace Webhook & Intake Security

export async function getWorkspaceSecurityProfile(
  orgId: string,
): Promise<WorkspaceSecurityProfile | null> {
  assertVerifiedOrgId(orgId, "getWorkspaceSecurityProfile");
  const rows = await identityQuery<ResolvedOrgWebhookRow>(
    `SELECT id, name, active, webhook_token, intake_api_key_hash, intake_api_key_prefix,
            whatsapp_phone_number_id, whatsapp_verify_token, whatsapp_app_secret_sealed,
            telegram_webhook_secret_hash
       FROM organisations WHERE id = $1 LIMIT 1`,
    [orgId],
  );
  if (rows.length === 0) return null;
  let org = rows[0];
  if (!org.webhook_token) {
    const generated = randomBytes(18).toString("hex");
    const updated = await identityQuery<ResolvedOrgWebhookRow>(
      `UPDATE organisations SET webhook_token = $1 WHERE id = $2 RETURNING *`,
      [generated, orgId],
    );
    if (updated[0]) org = updated[0];
  }
  return {
    orgId: org.id,
    orgName: org.name,
    webhookToken: org.webhook_token ?? "",
    intakeApiKeyPrefix: org.intake_api_key_prefix ?? null,
    hasIntakeApiKey: Boolean(org.intake_api_key_hash),
    whatsappPhoneNumberId: org.whatsapp_phone_number_id ?? null,
    hasWhatsappVerifyToken: Boolean(org.whatsapp_verify_token),
    hasWhatsappAppSecret: Boolean(org.whatsapp_app_secret_sealed),
    hasTelegramWebhookSecret: Boolean(org.telegram_webhook_secret_hash),
  };
}

export async function rotateWorkspaceWebhookToken(
  orgId: string,
  actor: SessionUser,
): Promise<{ webhookToken: string }> {
  assertVerifiedOrgId(orgId, "rotateWorkspaceWebhookToken");
  if (actor.orgId !== orgId || actor.role !== "ADMIN") {
    throw new Error("Workspace administrator privileges are required.");
  }
  const nextToken = randomBytes(18).toString("hex");
  await identityQuery(
    `UPDATE organisations SET webhook_token = $1 WHERE id = $2 RETURNING id`,
    [nextToken, orgId],
  );
  await recordAudit({
    actor: actor.email,
    actorType: "USER",
    action: "WORKSPACE_WEBHOOK_TOKEN_ROTATED",
    orgId,
    entityType: `org:${orgId}`,
  });
  return { webhookToken: nextToken };
}

export async function rotateWorkspaceIntakeKey(
  orgId: string,
  actor: SessionUser,
): Promise<{ apiKey: string; prefix: string }> {
  assertVerifiedOrgId(orgId, "rotateWorkspaceIntakeKey");
  if (actor.orgId !== orgId || actor.role !== "ADMIN") {
    throw new Error("Workspace administrator privileges are required.");
  }
  const rawKey = `ct_ws_${randomBytes(24).toString("hex")}`;
  const prefix = rawKey.slice(0, 14);
  const hash = sha256Hex(rawKey);
  await identityQuery(
    `UPDATE organisations SET intake_api_key_hash = $1, intake_api_key_prefix = $2 WHERE id = $3 RETURNING id`,
    [hash, prefix, orgId],
  );
  await recordAudit({
    actor: actor.email,
    actorType: "USER",
    action: "WORKSPACE_INTAKE_KEY_ROTATED",
    orgId,
    entityType: `org:${orgId}`,
    after: { prefix },
  });
  return { apiKey: rawKey, prefix };
}

export async function updateWorkspaceChannelSecrets(
  orgId: string,
  actor: SessionUser,
  input: {
    whatsappPhoneNumberId?: string | null;
    whatsappVerifyToken?: string | null;
    whatsappAppSecret?: string | null;
    telegramWebhookSecret?: string | null;
  },
): Promise<WorkspaceSecurityProfile | null> {
  assertVerifiedOrgId(orgId, "updateWorkspaceChannelSecrets");
  if (actor.orgId !== orgId || actor.role !== "ADMIN") {
    throw new Error("Workspace administrator privileges are required.");
  }

  const currentRows = await identityQuery<ResolvedOrgWebhookRow>(
    `SELECT * FROM organisations WHERE id = $1 LIMIT 1`,
    [orgId],
  );
  const current = currentRows[0];
  if (!current) return null;

  if (
    input.whatsappPhoneNumberId !== undefined ||
    input.whatsappVerifyToken !== undefined ||
    input.whatsappAppSecret !== undefined
  ) {
    const phoneId =
      input.whatsappPhoneNumberId !== undefined
        ? input.whatsappPhoneNumberId?.trim() || null
        : current.whatsapp_phone_number_id ?? null;
    const verifyTok =
      input.whatsappVerifyToken !== undefined
        ? input.whatsappVerifyToken?.trim() || null
        : current.whatsapp_verify_token ?? null;
    const appSecretSealed =
      input.whatsappAppSecret !== undefined
        ? input.whatsappAppSecret?.trim()
          ? sealWebhookSecret(input.whatsappAppSecret.trim())
          : null
        : current.whatsapp_app_secret_sealed ?? null;

    await identityQuery(
      `UPDATE organisations
          SET whatsapp_phone_number_id = $1,
              whatsapp_verify_token = $2,
              whatsapp_app_secret_sealed = $3
        WHERE id = $4
        RETURNING id`,
      [phoneId, verifyTok, appSecretSealed, orgId],
    );
  }

  if (input.telegramWebhookSecret !== undefined) {
    const secretHash = input.telegramWebhookSecret?.trim()
      ? sha256Hex(input.telegramWebhookSecret.trim())
      : null;
    await identityQuery(
      `UPDATE organisations SET telegram_webhook_secret_hash = $1 WHERE id = $2 RETURNING id`,
      [secretHash, orgId],
    );
  }

  await recordAudit({
    actor: actor.email,
    actorType: "USER",
    action: "WORKSPACE_CHANNEL_SECRETS_UPDATED",
    orgId,
    entityType: `org:${orgId}`,
  });

  return getWorkspaceSecurityProfile(orgId);
}

export async function resolveOrgByWebhookToken(
  webhookToken: string | null | undefined,
): Promise<ResolvedOrgWebhookRow | null> {
  if (!webhookToken) return null;
  const tok = webhookToken.trim();
  if (tok.length < 12 || tok.length > 128) return null;
  const rows = await identityQuery<ResolvedOrgWebhookRow>(
    `SELECT * FROM organisations WHERE webhook_token = $1 LIMIT 1`,
    [tok],
  );
  const org = rows[0];
  if (!org || !org.active || !org.webhook_token) return null;
  if (!constantTimeTokenEqual(org.webhook_token, tok)) return null;
  return org;
}

export async function resolveOrgByWhatsAppPhoneId(
  phoneNumberId: string | null | undefined,
): Promise<ResolvedOrgWebhookRow | null> {
  if (!phoneNumberId || !phoneNumberId.trim()) return null;
  const rows = await identityQuery<ResolvedOrgWebhookRow>(
    `SELECT * FROM organisations WHERE whatsapp_phone_number_id = $1 LIMIT 1`,
    [phoneNumberId.trim()],
  );
  const org = rows[0];
  if (!org || !org.active) return null;
  return org;
}

export async function resolveOrgByIntakeApiKey(
  rawApiKey: string | null | undefined,
): Promise<ResolvedOrgWebhookRow | null> {
  if (!rawApiKey) return null;
  const trimmed = rawApiKey.trim();
  if (trimmed.length < 16 || trimmed.length > 256) return null;
  const hash = sha256Hex(trimmed);
  const rows = await identityQuery<ResolvedOrgWebhookRow>(
    `SELECT * FROM organisations WHERE intake_api_key_hash = $1 LIMIT 1`,
    [hash],
  );
  const org = rows[0];
  if (!org || !org.active || !org.intake_api_key_hash) return null;
  if (!constantTimeTokenEqual(org.intake_api_key_hash, hash)) return null;
  return org;
}

export function unsealWorkspaceWhatsAppSecret(
  org: ResolvedOrgWebhookRow,
): string | null {
  if (!org.whatsapp_app_secret_sealed) return null;
  return unsealWebhookSecret(org.whatsapp_app_secret_sealed);
}

export function verifyWorkspaceTelegramSecret(
  org: ResolvedOrgWebhookRow,
  providedHeader: string | null | undefined,
): boolean {
  if (!org.telegram_webhook_secret_hash || !providedHeader) return false;
  const providedHash = sha256Hex(providedHeader.trim());
  return constantTimeTokenEqual(org.telegram_webhook_secret_hash, providedHash);
}

/**
 * Claims a webhook delivery ID for a tenant to prevent replay attacks.
 * Uses both in-memory fast deduplication and DB-backed RLS `webhook_deliveries`.
 */
export async function claimWorkspaceWebhookDelivery(
  orgId: string,
  channel: "WHATSAPP" | "TELEGRAM",
  deliveryId: string,
): Promise<boolean> {
  assertVerifiedOrgId(orgId, "claimWorkspaceWebhookDelivery");
  if (!deliveryId) return true;
  const res = await claimDistributedWebhookReplay(orgId, channel, deliveryId);
  return res.fresh;
}

import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  getWorkspaceConfiguration,
  saveWorkspaceConfiguration,
  type SaveWorkspaceConfigurationInput,
} from "@/lib/business-config/store";
import {
  FEATURE_KEYS,
  type FeatureKey,
} from "@/lib/business-config/types";
import { verifySameOriginMutation } from "@/lib/request-origin";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const FEATURE_KEY_SET = new Set<string>(FEATURE_KEYS);

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const bundle = await getWorkspaceConfiguration(user.orgId);
  return NextResponse.json({
    ok: true,
    ...bundle,
    canEdit: user.role === "ADMIN",
  });
}

export async function PUT(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only workspace administrators can update business configuration and feature entitlements." },
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

  // Strictly sanitize entitlementOverrides against known feature keys
  let entitlementOverrides: Partial<Record<FeatureKey, boolean>> | undefined;
  if (body.entitlementOverrides && typeof body.entitlementOverrides === "object") {
    entitlementOverrides = {};
    for (const [k, v] of Object.entries(body.entitlementOverrides as Record<string, unknown>)) {
      if (FEATURE_KEY_SET.has(k) && typeof v === "boolean") {
        entitlementOverrides[k as FeatureKey] = v;
      }
    }
  }

  const input: SaveWorkspaceConfigurationInput = {
    profile:
      body.profile && typeof body.profile === "object"
        ? (body.profile as SaveWorkspaceConfigurationInput["profile"])
        : undefined,
    approvedConfig:
      body.approvedConfig && typeof body.approvedConfig === "object"
        ? (body.approvedConfig as SaveWorkspaceConfigurationInput["approvedConfig"])
        : undefined,
    approve: typeof body.approve === "boolean" ? body.approve : undefined,
    entitlementOverrides,
    applyGrowthReassessment:
      typeof body.applyGrowthReassessment === "boolean"
        ? body.applyGrowthReassessment
        : undefined,
    preserveAdminOverrides:
      typeof body.preserveAdminOverrides === "boolean"
        ? body.preserveAdminOverrides
        : true,
    note: typeof body.note === "string" ? body.note.slice(0, 300) : undefined,
  };

  const bundle = await saveWorkspaceConfiguration(user.orgId, user.email, input);
  return NextResponse.json({
    ok: true,
    ...bundle,
    canEdit: true,
  });
}

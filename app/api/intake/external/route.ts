import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  dispatchToAutonomousAgent,
  resolveDefaultOrgId,
  type AutonomousIntent,
} from "@/lib/agents/autonomous";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const TYPE_TO_INTENT: Record<string, AutonomousIntent> = {
  order: "NEW_ORDER",
  new_order: "NEW_ORDER",
  shipment: "NEW_ORDER",
  booking: "NEW_ORDER",
  planning: "PLANNING_ROUTING",
  routing: "PLANNING_ROUTING",
  reroute: "PLANNING_ROUTING",
  route: "PLANNING_ROUTING",
  action: "SHIPMENT_ACTION",
  update: "SHIPMENT_ACTION",
  exception: "EXCEPTION_REPORT",
  delay: "EXCEPTION_REPORT",
  incident: "EXCEPTION_REPORT",
  customs: "CUSTOMS_DOCS",
  document: "CUSTOMS_DOCS",
  billing: "BILLING_INVOICE",
  invoice: "BILLING_INVOICE",
  info: "SHIPMENT_ACTION",
  tracking: "TRACKING_INQUIRY",
};

export async function POST(req: NextRequest) {
  const user = await currentUser();
  const configuredToken = process.env.EXTERNAL_INTAKE_TOKEN?.trim();

  if (!user && configuredToken) {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const headerToken = req.headers.get("x-intake-token")?.trim();
    if (bearer !== configuredToken && headerToken !== configuredToken) {
      return NextResponse.json({ error: "Unauthorized intake token." }, { status: 401 });
    }
  }

  let body: {
    type?: string;
    intent?: AutonomousIntent;
    source?: string;
    message?: string;
    reference?: string;
    customerName?: string;
    customerEmail?: string;
    origin?: string;
    originCity?: string;
    destination?: string;
    destinationCity?: string;
    cargo?: string;
    cargoDescription?: string;
    weightKg?: number;
    quantity?: number;
    deadline?: string;
    deadlineIso?: string;
    requiredBy?: string;
    preferredMode?: string;
    hazmat?: boolean;
    reefer?: boolean;
    currency?: string;
    notes?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const originCity = (body.originCity ?? body.origin)?.trim() || null;
  const destinationCity = (body.destinationCity ?? body.destination)?.trim() || null;
  const cargoDescription = (body.cargoDescription ?? body.cargo)?.trim() || null;
  const deadlineIso = (body.deadlineIso ?? body.deadline ?? body.requiredBy)?.trim() || null;
  const rawMessage =
    body.message?.trim() ||
    [
      body.type ? `External ${body.type} intake` : "External logistics intake",
      originCity && destinationCity ? `from ${originCity} to ${destinationCity}` : "",
      cargoDescription ? `cargo: ${cargoDescription}` : "",
      body.reference ? `ref: ${body.reference}` : "",
      body.notes ? `notes: ${body.notes}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  if (!rawMessage) {
    return NextResponse.json(
      { error: "Provide a message or structured order/planning details." },
      { status: 400 },
    );
  }

  const mappedIntent =
    body.intent ??
    (body.type ? TYPE_TO_INTENT[body.type.trim().toLowerCase()] : undefined);

  const orgId = user?.orgId ?? (await resolveDefaultOrgId());
  const out = await dispatchToAutonomousAgent({
    sourceChannel: "EXTERNAL_API",
    intentHint: mappedIntent,
    message: rawMessage,
    reference: body.reference ?? null,
    externalId: body.source?.trim() || "external-api",
    displayName: body.customerName ?? body.source ?? "External Partner",
    orgId,
    actorEmail: user?.email ?? body.customerEmail ?? "api@external-intake",
    mode: "sync_orchestrate",
    structured: {
      originCity,
      destinationCity,
      cargoDescription,
      weightKg:
        typeof body.weightKg === "number" && Number.isFinite(body.weightKg)
          ? body.weightKg
          : null,
      quantity:
        typeof body.quantity === "number" && Number.isFinite(body.quantity)
          ? Math.round(body.quantity)
          : null,
      deadlineIso,
      preferredMode: body.preferredMode ?? null,
      customerName: body.customerName ?? null,
      customerEmail: body.customerEmail ?? null,
      hazmat: Boolean(body.hazmat),
      reefer: Boolean(body.reefer),
      currency: body.currency ?? "NGN",
      notes: body.notes ?? null,
    },
  });

  revalidatePath("/orders");
  revalidatePath("/shipments");
  revalidatePath("/planning");
  revalidatePath("/exceptions");
  revalidatePath("/queue");
  revalidatePath("/activity");

  return NextResponse.json(
    {
      ok: true,
      ...out,
    },
    { status: out.orderReference || out.shipmentReference ? 201 : 200 },
  );
}

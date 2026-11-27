import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { currentUser } from "@/lib/auth";
import { isSameOriginMutation } from "@/lib/intelligence/access";
import {
  cadenceDays,
  computeSyncStatus,
  evaluateMixedShipmentLoad,
  nextPdcaStage,
  nextPostponementStage,
  parseBarcodeToken,
} from "@/lib/tactics/engine";
import {
  collectTacticsSnapshot,
  updateTenantTacticsMutations,
} from "@/lib/tactics/store";
import type {
  CommunicationCadence,
  MixedLoadSkuLine,
  MixedShipmentPlan,
  PreArrivalStage,
  ScanCheckpoint,
} from "@/lib/tactics/types";

export const dynamic = "force-dynamic";

const ALLOWED_CADENCES = new Set<CommunicationCadence>([
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
]);
const ALLOWED_CHANNELS = new Set(["VIDEO_CALL", "EMAIL", "EDI_PORTAL", "PHONE"]);
const ALLOWED_CHECKPOINTS = new Set<ScanCheckpoint>([
  "RECEIVING",
  "PUTAWAY",
  "PICKING",
  "CROSS_DOCK",
  "IN_TRANSIT",
  "DELIVERED",
]);
const ALLOWED_EQUIP = new Set<MixedShipmentPlan["equipmentType"]>([
  "DRY_VAN_53",
  "REEFER_40",
  "SPRINTER_VAN",
  "CONTAINER_40HC",
]);
const ALLOWED_PRE_ARRIVAL = new Set<PreArrivalStage>([
  "NOT_FILED",
  "PRE_FILED_IN_TRANSIT",
  "PRE_CLEARED_WHEELS_UP",
  "HELD",
]);

function cleanStr(v: unknown, maxLen = 220): string {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const snapshot = await collectTacticsSnapshot({
    orgId: user.orgId,
    orgName: user.orgName,
  });
  return NextResponse.json(snapshot);
}

export async function POST(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  if (user.role === "VIEWER") {
    return NextResponse.json(
      { error: "Read-only viewers cannot modify logistics tactic records." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const action = cleanStr(body.action, 60);
  const now = new Date();
  const nowIso = now.toISOString();

  const currentSnapshot = await collectTacticsSnapshot({
    orgId: user.orgId,
    orgName: user.orgName,
  });

  if (action === "log_supplier_sync") {
    const supplierName = cleanStr(body.supplierName, 120);
    const contactName = cleanStr(body.contactName, 100) || "Account Manager";
    const topic = cleanStr(body.topic, 180);
    const demandPlanSummary = cleanStr(body.demandPlanSummary, 320);
    const cadenceRaw = cleanStr(body.cadence, 20) as CommunicationCadence;
    const channelRaw = cleanStr(body.channel, 20);

    if (!supplierName || !topic) {
      return NextResponse.json(
        { error: "Supplier name and planning topic are required." },
        { status: 400 },
      );
    }

    const cadence: CommunicationCadence = ALLOWED_CADENCES.has(cadenceRaw)
      ? cadenceRaw
      : "WEEKLY";
    const channel = (
      ALLOWED_CHANNELS.has(channelRaw) ? channelRaw : "VIDEO_CALL"
    ) as "VIDEO_CALL" | "EMAIL" | "EDI_PORTAL" | "PHONE";
    const nextDueIso = new Date(
      now.getTime() + cadenceDays(cadence) * 86_400_000,
    ).toISOString();

    const syncId = `sync-${randomUUID().slice(0, 8)}`;
    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      supplierSyncs: [
        {
          id: syncId,
          supplierName,
          supplierCode: supplierName
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "")
            .slice(0, 8),
          contactName,
          cadence,
          channel,
          topic,
          demandPlanSummary:
            demandPlanSummary ||
            "Shared updated 30-day rolling demand forecast and confirmed capacity slots.",
          lastSyncedAt: nowIso,
          nextSyncDueAt: nextDueIso,
          status: computeSyncStatus(nextDueIso, now.getTime()),
          loggedBy: user.name || user.email,
        },
        ...cur.supplierSyncs,
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_SUPPLIER_SYNC_LOGGED",
      orgId: user.orgId,
      entityType: `supplier_sync:${syncId}`,
      after: { supplierName, cadence, topic },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "create_initiative") {
    const supplierName = cleanStr(body.supplierName, 120);
    const trendObservation = cleanStr(body.trendObservation, 280);
    const metricTracked = cleanStr(body.metricTracked, 80) || "On-Time Delivery %";
    const baselineValue = cleanStr(body.baselineValue, 40) || "Current";
    const targetValue = cleanStr(body.targetValue, 40) || "Target +5%";
    const sharedWithSupplier = Boolean(body.sharedWithSupplier);

    if (!supplierName || !trendObservation) {
      return NextResponse.json(
        { error: "Supplier name and trend observation are required." },
        { status: 400 },
      );
    }

    const id = `pdca-${randomUUID().slice(0, 8)}`;
    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      initiatives: [
        {
          id,
          supplierName,
          trendObservation,
          metricTracked,
          baselineValue,
          targetValue,
          stage: "PLAN",
          sharedWithSupplier,
          owner: user.name || user.email,
          updatedAt: nowIso,
        },
        ...cur.initiatives,
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_PDCA_CREATED",
      orgId: user.orgId,
      entityType: `pdca:${id}`,
      after: { supplierName, metricTracked, sharedWithSupplier },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "advance_initiative" || action === "share_initiative") {
    const initiativeId = cleanStr(body.initiativeId, 80);
    const existing = currentSnapshot.initiatives.find((i) => i.id === initiativeId);
    if (!existing) {
      return NextResponse.json(
        { error: "Continuous improvement initiative not found." },
        { status: 404 },
      );
    }

    const updated = {
      ...existing,
      stage:
        action === "advance_initiative"
          ? nextPdcaStage(existing.stage)
          : existing.stage,
      sharedWithSupplier:
        action === "share_initiative" ? true : existing.sharedWithSupplier,
      updatedAt: nowIso,
    };

    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      initiatives: [
        updated,
        ...cur.initiatives.filter((i) => i.id !== initiativeId),
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action:
        action === "advance_initiative"
          ? "TACTIC_PDCA_ADVANCED"
          : "TACTIC_TREND_SHARED_WITH_SUPPLIER",
      orgId: user.orgId,
      entityType: `pdca:${initiativeId}`,
      after: { stage: updated.stage, sharedWithSupplier: updated.sharedWithSupplier },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "record_barcode_scan") {
    const rawBarcode = cleanStr(body.barcode, 120);
    const warehouseCode = cleanStr(body.warehouseCode, 40);
    const checkpointRaw = cleanStr(body.checkpoint, 30) as ScanCheckpoint;
    const scannedQty = Number(body.scannedQty);
    const gpsLat = Number(body.gpsLat);
    const gpsLon = Number(body.gpsLon);

    if (!rawBarcode || !Number.isFinite(scannedQty) || scannedQty < 0) {
      return NextResponse.json(
        { error: "Valid barcode and non-negative scanned quantity are required." },
        { status: 400 },
      );
    }

    const knownSkus = currentSnapshot.availableInventory.map((i) => i.sku);
    const parsed = parseBarcodeToken(rawBarcode, knownSkus);
    const sku = cleanStr(body.sku, 60) || parsed.extractedSku || rawBarcode;
    const matchedInv = currentSnapshot.availableInventory.find(
      (i) =>
        i.sku.toLowerCase() === sku.toLowerCase() &&
        (!warehouseCode || i.warehouseCode === warehouseCode),
    );
    const resolvedWh =
      warehouseCode || matchedInv?.warehouseCode || currentSnapshot.postponementCenters[0]?.warehouseCode || "WH-MAIN";
    const expectedQty =
      Number.isFinite(Number(body.expectedQty)) && Number(body.expectedQty) >= 0
        ? Number(body.expectedQty)
        : matchedInv?.onHand ?? Math.round(scannedQty);
    const variance = Math.round(scannedQty) - expectedQty;
    const checkpoint: ScanCheckpoint = ALLOWED_CHECKPOINTS.has(checkpointRaw)
      ? checkpointRaw
      : "RECEIVING";

    const scanId = `scan-${randomUUID().slice(0, 8)}`;
    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      barcodeScans: [
        {
          id: scanId,
          barcode: parsed.normalizedBarcode,
          sku,
          warehouseCode: resolvedWh,
          checkpoint,
          expectedQty,
          scannedQty: Math.round(scannedQty),
          variance,
          gpsLat: Number.isFinite(gpsLat) ? Math.round(gpsLat * 10000) / 10000 : 6.5244,
          gpsLon: Number.isFinite(gpsLon) ? Math.round(gpsLon * 10000) / 10000 : 3.3792,
          locationLabel: cleanStr(body.locationLabel, 100) || resolvedWh,
          scannedBy: user.name || user.email,
          scannedAt: nowIso,
        },
        ...cur.barcodeScans,
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_BARCODE_GPS_SCAN",
      orgId: user.orgId,
      entityType: `barcode_scan:${scanId}`,
      after: { sku, warehouseCode: resolvedWh, checkpoint, scannedQty, variance },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "toggle_cross_dock") {
    const warehouseCode = cleanStr(body.warehouseCode, 40);
    const sku = cleanStr(body.sku, 60);
    if (!warehouseCode || !sku) {
      return NextResponse.json(
        { error: "Warehouse code and SKU are required." },
        { status: 400 },
      );
    }
    const key = `${warehouseCode}::${sku}`;
    updateTenantTacticsMutations(user.orgId, (cur) => {
      const exists = cur.crossDockSkuKeys.includes(key);
      return {
        ...cur,
        crossDockSkuKeys: exists
          ? cur.crossDockSkuKeys.filter((k) => k !== key)
          : [...cur.crossDockSkuKeys, key],
      };
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_CROSS_DOCK_TOGGLED",
      orgId: user.orgId,
      entityType: `flow_through:${key}`,
      after: { warehouseCode, sku },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "toggle_postponement_center") {
    const warehouseCode = cleanStr(body.warehouseCode, 40);
    if (!warehouseCode) {
      return NextResponse.json(
        { error: "Warehouse code is required." },
        { status: 400 },
      );
    }

    const currentlyEnabled = currentSnapshot.postponementCenters
      .filter((c) => c.enabled)
      .map((c) => c.warehouseCode);

    const nextEnabled = currentlyEnabled.includes(warehouseCode)
      ? currentlyEnabled.filter((c) => c !== warehouseCode)
      : [...currentlyEnabled, warehouseCode];

    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      postponementWarehouseCodes:
        nextEnabled.length > 0 ? nextEnabled : ["__NONE__"],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_POSTPONEMENT_CENTER_UPDATED",
      orgId: user.orgId,
      entityType: `postponement_center:${warehouseCode}`,
      after: { warehouseCode, enabled: nextEnabled.includes(warehouseCode) },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "create_postponement_order") {
    const warehouseCode = cleanStr(body.warehouseCode, 40);
    const customerName = cleanStr(body.customerName, 120);
    const baseSku = cleanStr(body.baseSku, 60);
    const finalConfiguration = cleanStr(body.finalConfiguration, 200);
    const quantity = Math.round(Number(body.quantity));

    if (
      !warehouseCode ||
      !customerName ||
      !baseSku ||
      !finalConfiguration ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return NextResponse.json(
        { error: "Complete postponement center, customer, base SKU, configuration, and quantity." },
        { status: 400 },
      );
    }

    const id = `pp-${randomUUID().slice(0, 8)}`;
    const unitAvoided = currentSnapshot.currency === "NGN" ? 6_500 : 28;
    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      postponementOrders: [
        {
          id,
          warehouseCode,
          customerName,
          baseSku,
          finalConfiguration,
          quantity,
          stage: "BASE_STOCK_HELD",
          leadHoursSaved: Math.min(48, Math.max(8, Math.round(quantity * 0.4))),
          avoidedMismatchCostMajor: quantity * unitAvoided,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        ...cur.postponementOrders,
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_POSTPONEMENT_ORDER_CREATED",
      orgId: user.orgId,
      entityType: `postponement_order:${id}`,
      after: { warehouseCode, customerName, baseSku, quantity },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "advance_postponement_order") {
    const orderId = cleanStr(body.orderId, 80);
    const existing = currentSnapshot.postponementOrders.find(
      (o) => o.id === orderId,
    );
    if (!existing) {
      return NextResponse.json(
        { error: "Postponement work order not found." },
        { status: 404 },
      );
    }

    const updated = {
      ...existing,
      stage: nextPostponementStage(existing.stage),
      updatedAt: nowIso,
    };

    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      postponementOrders: [
        updated,
        ...cur.postponementOrders.filter((o) => o.id !== orderId),
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_POSTPONEMENT_ORDER_ADVANCED",
      orgId: user.orgId,
      entityType: `postponement_order:${orderId}`,
      after: { stage: updated.stage },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "create_mixed_shipment") {
    const customerName = cleanStr(body.customerName, 120);
    const destinationCity = cleanStr(body.destinationCity, 100);
    const equipmentRaw = cleanStr(
      body.equipmentType,
      30,
    ) as MixedShipmentPlan["equipmentType"];
    const equipmentType: MixedShipmentPlan["equipmentType"] = ALLOWED_EQUIP.has(
      equipmentRaw,
    )
      ? equipmentRaw
      : "DRY_VAN_53";

    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const lines: MixedLoadSkuLine[] = rawLines
      .slice(0, 12)
      .map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>;
        return {
          sku: cleanStr(obj.sku, 60),
          warehouseCode: cleanStr(obj.warehouseCode, 40) || "WH-MAIN",
          quantity: Math.max(0, Math.round(Number(obj.quantity) || 0)),
          unitWeightKg: Math.max(0.5, Number(obj.unitWeightKg) || 12),
          unitVolumeCbm: Math.max(0.02, Number(obj.unitVolumeCbm) || 0.1),
          hazmat: Boolean(obj.hazmat),
          reefer: Boolean(obj.reefer),
        };
      })
      .filter((l) => l.sku && l.quantity > 0);

    if (!customerName || !destinationCity || lines.length === 0) {
      return NextResponse.json(
        { error: "Customer, destination city, and at least one SKU line are required." },
        { status: 400 },
      );
    }

    const evalRes = evaluateMixedShipmentLoad(lines, equipmentType);
    if (!evalRes.compatible) {
      return NextResponse.json(
        { error: evalRes.warnings[0] ?? "Mixed shipment failed capacity or safety validation." },
        { status: 400 },
      );
    }

    const id = `mix-${randomUUID().slice(0, 8)}`;
    const reference = `MIX-${Math.floor(1000 + Math.random() * 9000)}`;
    updateTenantTacticsMutations(user.orgId, (cur) => ({
      ...cur,
      mixedShipments: [
        {
          id,
          reference,
          customerName,
          destinationCity,
          equipmentType,
          lines,
          totalUnits: evalRes.totalUnits,
          totalWeightKg: evalRes.totalWeightKg,
          totalVolumeCbm: evalRes.totalVolumeCbm,
          weightFillPct: evalRes.weightFillPct,
          volumeFillPct: evalRes.volumeFillPct,
          deliveriesConsolidated: evalRes.consolidatedDeliveriesSaved,
          warnings: evalRes.warnings,
          status: "DISPATCHED",
          createdAt: nowIso,
          createdBy: user.name || user.email,
        },
        ...cur.mixedShipments,
      ],
    }));

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_MIXED_SHIPMENT_DISPATCHED",
      orgId: user.orgId,
      entityType: `mixed_shipment:${reference}`,
      after: {
        reference,
        customerName,
        skuCount: lines.length,
        totalUnits: evalRes.totalUnits,
      },
      userAgent: req.headers.get("user-agent"),
    });
  } else if (action === "update_pre_arrival_customs") {
    const shipmentRef = cleanStr(body.shipmentRef, 60);
    const stageRaw = cleanStr(body.stage, 40) as PreArrivalStage;
    const broker = cleanStr(body.broker, 100);
    if (!shipmentRef || !ALLOWED_PRE_ARRIVAL.has(stageRaw)) {
      return NextResponse.json(
        { error: "Valid shipment reference and pre-arrival clearance stage are required." },
        { status: 400 },
      );
    }

    updateTenantTacticsMutations(user.orgId, (cur) => {
      const prev = cur.preArrivalFilings[shipmentRef] ?? {};
      return {
        ...cur,
        preArrivalFilings: {
          ...cur.preArrivalFilings,
          [shipmentRef]: {
            ...prev,
            stage: stageRaw,
            ...(broker ? { broker } : {}),
            hasCommercialInvoice: true,
            hasPackingList: true,
            hasWaybill: true,
            filedAt:
              stageRaw === "PRE_FILED_IN_TRANSIT" ||
              stageRaw === "PRE_CLEARED_WHEELS_UP"
                ? prev.filedAt ?? nowIso
                : prev.filedAt ?? null,
            clearedAt:
              stageRaw === "PRE_CLEARED_WHEELS_UP" ? nowIso : null,
          },
        },
      };
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "TACTIC_PRE_ARRIVAL_CUSTOMS_UPDATED",
      orgId: user.orgId,
      entityType: `pre_arrival_customs:${shipmentRef}`,
      after: { shipmentRef, stage: stageRaw },
      userAgent: req.headers.get("user-agent"),
    });
  } else {
    return NextResponse.json(
      { error: "Unsupported logistics tactic action." },
      { status: 400 },
    );
  }

  const nextSnapshot = await collectTacticsSnapshot({
    orgId: user.orgId,
    orgName: user.orgName,
  });
  return NextResponse.json(nextSnapshot);
}

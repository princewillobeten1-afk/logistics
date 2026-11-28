import { NextRequest, NextResponse } from "next/server";
import { scheduleBackgroundAgent } from "@/lib/agents/background";
import { currentUser, may } from "@/lib/auth";
import { isReachable, query, runWithOrgScope } from "@/lib/db";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";
import {
  computeLogisticsReadiness,
  findNearbyDrivers,
  normalizeDutyStatus,
  resolveCityCoordinates,
  type DriverDutyStatus,
  type GeoTarget,
} from "@/lib/driver-dispatch";
import {
  listDocuments,
  listDrivers,
  listLocations,
  listShipments,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const ALLOWED_DUTY_STATUSES = new Set<DriverDutyStatus>([
  "AVAILABLE",
  "ON_ROUTE",
  "RESTING",
  "OFF_DUTY",
]);

const ALLOWED_EQUIPMENT = new Set([
  "DRY_VAN",
  "REEFER",
  "FLATBED",
  "BOX_TRUCK",
  "TANKER",
  "CONTAINER_CHASSIS",
]);

function parseBoolParam(raw: string | null): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseFiniteNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isValidCoords(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const tamper = detectWorkspaceTampering(request, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }
  if (!hasDepartmentAccess(user, "FLEET")) {
    return NextResponse.json(
      { error: "Your department scope does not include Fleet operations." },
      { status: 403 },
    );
  }

  try {
    return await runWithOrgScope(user.orgId, async () => {
      const sp = request.nextUrl.searchParams;
      const latParam = parseFiniteNumber(sp.get("lat"));
      const lonParam = parseFiniteNumber(sp.get("lon"));
      const cityParam = sp.get("city")?.trim() || null;
      const shipmentRef = sp.get("shipmentRef")?.trim() || null;
      const radiusKm = Math.max(
        5,
        Math.min(5000, parseFiniteNumber(sp.get("radiusKm")) ?? 300),
      );
      const onlyAvailable = parseBoolParam(sp.get("onlyAvailable"));
      const requireValidLicence = parseBoolParam(sp.get("requireValidLicence"));
      const requireHazmat = parseBoolParam(sp.get("hazmat"));
      const requireReefer = parseBoolParam(sp.get("reefer"));
      const minHosDriveHours = Math.max(
        0,
        Math.min(11, parseFiniteNumber(sp.get("minHosHours")) ?? 2),
      );
      const minPayloadKg = Math.max(
        0,
        parseFiniteNumber(sp.get("minPayloadKg")) ?? 0,
      );
      const equipmentType = sp.get("equipmentType")?.trim().toUpperCase() || null;

      const [drivers, locations, shipments, documents] = await Promise.all([
        listDrivers(),
        listLocations(),
        listShipments(),
        listDocuments(),
      ]);

      const activeShipments = shipments.filter(
        (s) =>
          !["CLOSED", "CANCELLED", "FAILED", "DELIVERED", "POD_VERIFIED"].includes(
            s.state,
          ),
      );

      let target: GeoTarget | null = null;
      let resolvedShipment: (typeof shipments)[number] | null = null;

      if (shipmentRef) {
        resolvedShipment =
          shipments.find(
            (s) => s.reference.toUpperCase() === shipmentRef.toUpperCase(),
          ) ?? null;
        if (resolvedShipment) {
          const originLat = parseFiniteNumber(resolvedShipment.origin?.lat ?? resolvedShipment.origin?.latitude);
          const originLon = parseFiniteNumber(resolvedShipment.origin?.lon ?? resolvedShipment.origin?.longitude);
          const originCity =
            typeof resolvedShipment.origin?.city === "string"
              ? resolvedShipment.origin.city
              : null;
          if (originLat !== null && originLon !== null && isValidCoords(originLat, originLon)) {
            target = {
              lat: originLat,
              lon: originLon,
              label: `${resolvedShipment.reference} pickup (${originCity ?? "origin"})`,
              city: originCity,
            };
          } else if (originCity) {
            const resolved = resolveCityCoordinates(originCity, locations);
            if (resolved) {
              target = {
                ...resolved,
                label: `${resolvedShipment.reference} pickup · ${resolved.label}`,
              };
            }
          }
        }
      }

      if (
        !target &&
        latParam !== null &&
        lonParam !== null &&
        isValidCoords(latParam, lonParam)
      ) {
        target = {
          lat: latParam,
          lon: lonParam,
          label: cityParam
            ? `${cityParam} (${latParam.toFixed(3)}, ${lonParam.toFixed(3)})`
            : `Coordinates (${latParam.toFixed(4)}, ${lonParam.toFixed(4)})`,
          city: cityParam,
        };
      }

      if (!target && cityParam) {
        target = resolveCityCoordinates(cityParam, locations);
      }

      if (!target) {
        const firstLocated = locations.find(
          (l) =>
            l.latitude !== null &&
            l.longitude !== null &&
            isValidCoords(Number(l.latitude), Number(l.longitude)),
        );
        if (firstLocated) {
          target = {
            lat: Number(firstLocated.latitude),
            lon: Number(firstLocated.longitude),
            label: firstLocated.city
              ? `${firstLocated.name} (${firstLocated.city})`
              : firstLocated.name,
            city: firstLocated.city,
          };
        }
      }

      const matches = target
        ? findNearbyDrivers(
            drivers,
            target,
            {
              maxRadiusKm: radiusKm,
              onlyAvailable,
              requireValidLicence,
              requireHazmat,
              requireReefer,
              minHosDriveHours,
              minPayloadKg: minPayloadKg > 0 ? minPayloadKg : undefined,
              equipmentType:
                equipmentType && ALLOWED_EQUIPMENT.has(equipmentType)
                  ? equipmentType
                  : null,
            },
            locations,
          )
        : [];

      const readiness = computeLogisticsReadiness({
        drivers,
        shipments,
        documents,
      });

      return NextResponse.json(
        {
          target,
          shipment: resolvedShipment
            ? {
                id: resolvedShipment.id,
                reference: resolvedShipment.reference,
                state: resolvedShipment.state,
                origin: resolvedShipment.origin,
                destination: resolvedShipment.destination,
                cargo: resolvedShipment.cargo,
                plan: resolvedShipment.plan,
              }
            : null,
          matches,
          drivers,
          locations,
          activeShipments: activeShipments.slice(0, 40).map((s) => ({
            id: s.id,
            reference: s.reference,
            state: s.state,
            originCity:
              typeof s.origin?.city === "string" ? s.origin.city : null,
            destinationCity:
              typeof s.destination?.city === "string"
                ? s.destination.city
                : null,
            hazmat: Boolean(s.cargo?.hazmat),
            reefer: Boolean(s.cargo?.reefer || s.cargo?.temp_controlled),
            weightKg: parseFiniteNumber(s.cargo?.weight_kg),
            assignedDriverName:
              typeof (s.plan as Record<string, unknown> | null)
                ?.assigned_driver_name === "string"
                ? String(
                    (s.plan as Record<string, unknown>).assigned_driver_name,
                  )
                : null,
          })),
          readiness,
          fetchedAt: new Date().toISOString(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not locate nearby drivers.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  if (!may(user.role, "EDIT_SHIPMENT") || !hasDepartmentAccess(user, "FLEET")) {
    return NextResponse.json(
      { error: "Fleet dispatcher permissions are required for driver mutations." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload." },
      { status: 400 },
    );
  }

  const tamper = detectWorkspaceTampering(request, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const action = String(body.action ?? "").trim();
  if (!["register_driver", "update_gps", "dispatch_driver"].includes(action)) {
    return NextResponse.json(
      {
        error:
          "Unsupported action. Expected register_driver, update_gps, or dispatch_driver.",
      },
      { status: 400 },
    );
  }

  try {
    return await runWithOrgScope(user.orgId, async () => {
      if (action === "register_driver") {
        const name = String(body.name ?? "").trim();
        const phone = String(body.phone ?? "").trim();
        const licenceNumber = String(body.licenceNumber ?? "")
          .trim()
          .toUpperCase();
        const licenceExpiryRaw = String(body.licenceExpiry ?? "").trim();
        const hazmatCertified = Boolean(body.hazmatCertified);
        const reeferCapable = Boolean(body.reeferCapable);
        const equipmentRaw = String(body.equipmentType ?? "DRY_VAN")
          .trim()
          .toUpperCase();
        const equipmentType = ALLOWED_EQUIPMENT.has(equipmentRaw)
          ? equipmentRaw
          : "DRY_VAN";
        const vehicleRegistration =
          String(body.vehicleRegistration ?? "")
            .trim()
            .toUpperCase() || null;
        const currentCity = String(body.currentCity ?? "").trim() || null;
        const dutyRaw = String(body.dutyStatus ?? "AVAILABLE")
          .trim()
          .toUpperCase() as DriverDutyStatus;
        const dutyStatus = ALLOWED_DUTY_STATUSES.has(dutyRaw)
          ? dutyRaw
          : "AVAILABLE";
        const hosDrive = Math.max(
          0,
          Math.min(11, parseFiniteNumber(body.hosDriveRemainingHours) ?? 9.5),
        );
        const hosDuty = Math.max(
          0,
          Math.min(14, parseFiniteNumber(body.hosDutyRemainingHours) ?? 12.0),
        );
        const maxPayloadKg = Math.max(
          500,
          Math.min(60000, parseFiniteNumber(body.maxPayloadKg) ?? 18000),
        );

        if (name.length < 2 || name.length > 120) {
          return NextResponse.json(
            { error: "Driver name must be between 2 and 120 characters." },
            { status: 400 },
          );
        }

        let lat = parseFiniteNumber(body.lat);
        let lon = parseFiniteNumber(body.lon);
        if ((lat === null || lon === null) && currentCity) {
          const locations = await listLocations();
          const resolved = resolveCityCoordinates(currentCity, locations);
          if (resolved) {
            lat = resolved.lat;
            lon = resolved.lon;
          }
        }
        if (lat !== null && lon !== null && !isValidCoords(lat, lon)) {
          return NextResponse.json(
            { error: "Latitude must be -90..90 and longitude must be -180..180." },
            { status: 400 },
          );
        }

        let licenceExpiryIso: string;
        if (licenceExpiryRaw) {
          const d = new Date(licenceExpiryRaw);
          if (Number.isNaN(d.getTime())) {
            return NextResponse.json(
              { error: "Invalid licence expiry date." },
              { status: 400 },
            );
          }
          licenceExpiryIso = d.toISOString().slice(0, 10);
        } else {
          licenceExpiryIso = new Date(Date.now() + 365 * 86_400_000)
            .toISOString()
            .slice(0, 10);
        }

        const resolvedLicence =
          licenceNumber || `CDL-${Date.now().toString().slice(-6)}`;

        let inserted: { id: string; name: string }[] = [];
        try {
          inserted = await query<{ id: string; name: string }>(
            `INSERT INTO drivers (
               name, phone, licence_number, licence_expiry, hazmat_certified,
               current_lat, current_lon, current_city, duty_status,
               hos_drive_remaining_hours, hos_duty_remaining_hours,
               vehicle_registration, equipment_type, reefer_capable, max_payload_kg
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             RETURNING id, name`,
            [
              name,
              phone || null,
              resolvedLicence,
              licenceExpiryIso,
              hazmatCertified,
              lat,
              lon,
              currentCity,
              dutyStatus,
              hosDrive,
              hosDuty,
              vehicleRegistration,
              equipmentType,
              reeferCapable || equipmentType === "REEFER",
              maxPayloadKg,
            ],
          );
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === "42703") {
            inserted = await query<{ id: string; name: string }>(
              `INSERT INTO drivers (name, phone, licence_number, licence_expiry, hazmat_certified)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, name`,
              [name, phone || null, resolvedLicence, licenceExpiryIso, hazmatCertified],
            );
          } else {
            throw err;
          }
        }

        await query(
          `INSERT INTO audit_logs (actor, actor_type, action, entity_type, entity_id, details)
           VALUES ($1, 'USER', 'DRIVER_REGISTERED', 'DRIVER', $2, $3::jsonb)`,
          [
            user.email,
            inserted[0]?.id ?? null,
            JSON.stringify({
              name,
              licence: resolvedLicence,
              city: currentCity,
              equipmentType,
              dutyStatus,
            }),
          ],
        );

        return NextResponse.json(
          {
            ok: true,
            driver: inserted[0] ?? { id: "", name },
            message: `Registered driver ${name} (${currentCity ?? "no city set"}).`,
          },
          { status: 201 },
        );
      }

      if (action === "update_gps") {
        const driverId = String(body.driverId ?? "").trim();
        if (!driverId) {
          return NextResponse.json(
            { error: "driverId is required." },
            { status: 400 },
          );
        }

        const currentCity = String(body.currentCity ?? "").trim() || null;
        let lat = parseFiniteNumber(body.lat);
        let lon = parseFiniteNumber(body.lon);

        if ((lat === null || lon === null) && currentCity) {
          const locations = await listLocations();
          const resolved = resolveCityCoordinates(currentCity, locations);
          if (resolved) {
            lat = resolved.lat;
            lon = resolved.lon;
          }
        }

        if (lat !== null && lon !== null && !isValidCoords(lat, lon)) {
          return NextResponse.json(
            { error: "Coordinates out of bounds." },
            { status: 400 },
          );
        }

        const dutyRaw = body.dutyStatus
          ? (String(body.dutyStatus).trim().toUpperCase() as DriverDutyStatus)
          : null;
        if (dutyRaw && !ALLOWED_DUTY_STATUSES.has(dutyRaw)) {
          return NextResponse.json(
            { error: "Invalid dutyStatus." },
            { status: 400 },
          );
        }

        const hosDrive = parseFiniteNumber(body.hosDriveRemainingHours);
        const hosDuty = parseFiniteNumber(body.hosDutyRemainingHours);

        const updated = await query<{ id: string; name: string }>(
          `UPDATE drivers
              SET current_lat = COALESCE($2, current_lat),
                  current_lon = COALESCE($3, current_lon),
                  current_city = COALESCE($4, current_city),
                  duty_status = COALESCE($5, duty_status),
                  hos_drive_remaining_hours = COALESCE($6, hos_drive_remaining_hours),
                  hos_duty_remaining_hours = COALESCE($7, hos_duty_remaining_hours),
                  last_ping_at = now()
            WHERE id = $1
            RETURNING id, name`,
          [
            driverId,
            lat,
            lon,
            currentCity,
            dutyRaw,
            hosDrive !== null ? Math.max(0, Math.min(11, hosDrive)) : null,
            hosDuty !== null ? Math.max(0, Math.min(14, hosDuty)) : null,
          ],
        );

        if (updated.length === 0) {
          return NextResponse.json(
            { error: "Driver not found in this workspace." },
            { status: 404 },
          );
        }

        return NextResponse.json({
          ok: true,
          driver: updated[0],
          message: `Updated live telemetry for ${updated[0].name}.`,
        });
      }

      // action === "dispatch_driver"
      const driverId = String(body.driverId ?? "").trim();
      const shipmentRef = String(body.shipmentRef ?? "").trim();
      if (!driverId || !shipmentRef) {
        return NextResponse.json(
          { error: "Both driverId and shipmentRef are required to dispatch." },
          { status: 400 },
        );
      }

      const [drivers, shipments] = await Promise.all([
        listDrivers(),
        listShipments(),
      ]);

      const driver = drivers.find((d) => d.id === driverId);
      if (!driver) {
        return NextResponse.json(
          { error: "Driver not found in this workspace." },
          { status: 404 },
        );
      }

      const shipment = shipments.find(
        (s) => s.reference.toUpperCase() === shipmentRef.toUpperCase(),
      );
      if (!shipment) {
        return NextResponse.json(
          { error: `Shipment ${shipmentRef} not found.` },
          { status: 404 },
        );
      }

      // Real TMS compliance gating before dispatch
      const blockers: string[] = [];
      const licenceDays =
        driver.days_to_expiry !== null &&
        Number.isFinite(Number(driver.days_to_expiry))
          ? Number(driver.days_to_expiry)
          : null;
      if (licenceDays !== null && licenceDays < 0) {
        blockers.push("Driver licence is expired.");
      }

      const dutyStatus = normalizeDutyStatus(driver);
      if (dutyStatus !== "AVAILABLE" || driver.assigned_to) {
        blockers.push(
          driver.assigned_to
            ? `Driver is already assigned to ${driver.assigned_to}.`
            : `Driver duty status is ${dutyStatus.replace(/_/g, " ")}.`,
        );
      }

      const hosDrive =
        typeof driver.hos_drive_remaining_hours === "number"
          ? driver.hos_drive_remaining_hours
          : 9.5;
      if (hosDrive < 2) {
        blockers.push(
          `Insufficient HOS drive time (${hosDrive.toFixed(1)}h remaining; minimum 2.0h required).`,
        );
      }

      const cargo = (shipment.cargo ?? {}) as Record<string, unknown>;
      if (cargo.hazmat && !driver.hazmat_certified) {
        blockers.push("Shipment requires hazmat certification.");
      }
      const driverReefer =
        Boolean(driver.reefer_capable) ||
        (driver.equipment_type ?? "").toUpperCase() === "REEFER";
      if ((cargo.reefer || cargo.temp_controlled) && !driverReefer) {
        blockers.push("Shipment requires a temperature-controlled reefer unit.");
      }

      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: `Dispatch blocked by safety/compliance gate: ${blockers.join(" ")}`,
            blockers,
          },
          { status: 409 },
        );
      }

      const planPatch = {
        assigned_driver_id: driver.id,
        assigned_driver_name: driver.name,
        assigned_driver_phone: driver.phone ?? null,
        assigned_vehicle: driver.vehicle_registration ?? driver.equipment_type ?? null,
        dispatched_at: new Date().toISOString(),
        dispatched_by: user.email,
      };

      await query(
        `UPDATE shipments
            SET plan = COALESCE(plan, '{}'::jsonb) || $1::jsonb,
                updated_at = now()
          WHERE id = $2`,
        [JSON.stringify(planPatch), shipment.id],
      );

      if (await isReachable()) {
        try {
          await query(
            `UPDATE drivers SET duty_status = 'ON_ROUTE', updated_at = now() WHERE id = $1`,
            [driver.id],
          );
        } catch {
          // Non-fatal if migration 022 hasn't been applied on remote Postgres yet
        }
        try {
          await query(
            `UPDATE shipment_legs
                SET driver_id = $1
              WHERE shipment_id = $2
                AND state IN ('PLANNED', 'BOOKED', 'IN_TRANSIT')`,
            [driver.id, shipment.id],
          );
        } catch {
          // Non-fatal if no open shipment leg exists yet
        }
      } else {
        await query(
          `UPDATE drivers SET assigned_to = $1, duty_status = $2 WHERE id = $3`,
          [shipment.reference, "ON_ROUTE", driver.id],
        );
      }

      await query(
        `INSERT INTO shipment_events (shipment_id, type, from_state, to_state, payload, actor)
         VALUES ($1, 'driver.dispatched', $2, $2, $3::jsonb, $4)`,
        [
          shipment.id,
          shipment.state,
          JSON.stringify({
            driver_id: driver.id,
            driver_name: driver.name,
            vehicle: driver.vehicle_registration ?? driver.equipment_type ?? null,
            hos_drive_remaining_hours: hosDrive,
            dispatched_by: user.email,
          }),
          user.email,
        ],
      );

      await query(
        `INSERT INTO audit_logs (actor, actor_type, action, entity_type, entity_id, details)
         VALUES ($1, 'USER', 'DRIVER_DISPATCHED', 'SHIPMENT', $2, $3::jsonb)`,
        [
          user.email,
          shipment.id,
          JSON.stringify({
            shipmentRef: shipment.reference,
            driverId: driver.id,
            driverName: driver.name,
          }),
        ],
      );

      scheduleBackgroundAgent({
        workflow: "planning.fleet_dispatch",
        orgId: user.orgId,
        reference: shipment.reference,
        actorEmail: user.email,
        task: `Driver ${driver.name} was dispatched to ${shipment.reference}. Verify HOS feasibility, route timing, and any follow-up staging alerts.`,
        workKind: "fleet.driver_dispatched",
        cooldownMs: 30_000,
      });

      return NextResponse.json({
        ok: true,
        shipmentRef: shipment.reference,
        driverId: driver.id,
        driverName: driver.name,
        message: `Dispatched ${driver.name} to ${shipment.reference}.`,
      });
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not complete driver dispatch request.",
      },
      { status: 500 },
    );
  }
}

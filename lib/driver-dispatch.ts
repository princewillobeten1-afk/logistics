import type {
  DocumentRow,
  DriverRow,
  LocationRow,
  ShipmentRow,
} from "@/lib/queries";

export type DriverDutyStatus = "AVAILABLE" | "ON_ROUTE" | "RESTING" | "OFF_DUTY";

export type DriverEquipmentType =
  | "DRY_VAN"
  | "REEFER"
  | "FLATBED"
  | "BOX_TRUCK"
  | "TANKER"
  | "CONTAINER_CHASSIS";

export interface GeoTarget {
  lat: number;
  lon: number;
  label: string;
  city?: string | null;
}

export interface NearbyDriverFilter {
  maxRadiusKm?: number;
  onlyAvailable?: boolean;
  requireValidLicence?: boolean;
  requireHazmat?: boolean;
  requireReefer?: boolean;
  minHosDriveHours?: number;
  minPayloadKg?: number;
  equipmentType?: string | null;
}

export interface NearbyDriverMatch {
  driver: DriverRow;
  lat: number;
  lon: number;
  distanceKm: number;
  roadDistanceKm: number;
  etaMinutes: number;
  dutyStatus: DriverDutyStatus;
  hosDriveRemainingHours: number;
  hosDutyRemainingHours: number;
  licenceDaysRemaining: number | null;
  eligible: boolean;
  blockingReasons: string[];
  warnings: string[];
  matchScore: number;
}

export interface DetentionRiskItem {
  reference: string;
  state: string;
  city: string | null;
  hoursSinceUpdate: number;
  estimatedExposureMinutes: number;
  severity: "HIGH" | "MEDIUM";
  reason: string;
}

export interface LogisticsReadinessReport {
  driversTotal: number;
  driversWithGps: number;
  driversAvailable: number;
  driversDispatchReady: number;
  driversExpiredLicence: number;
  driversExpiringSoon: number;
  driversLowHos: number;
  detentionRisks: DetentionRiskItem[];
  unverifiedPodBolCount: number;
  unassignedActiveShipments: number;
}

const EARTH_RADIUS_KM = 6371;
const ROAD_CIRCUITY_FACTOR = 1.22;
const AVG_APPROACH_SPEED_KPH = 58;
const DETENTION_FREE_TIME_HOURS = 2;

/**
 * Well-known logistics hub fallback coordinates when a workspace has not yet
 * seeded explicit location records for a city name.
 */
export const KNOWN_LOGISTICS_CITY_COORDS: Record<
  string,
  { lat: number; lon: number; label: string }
> = {
  lagos: { lat: 6.5244, lon: 3.3792, label: "Lagos" },
  apapa: { lat: 6.4488, lon: 3.359, label: "Apapa Port, Lagos" },
  ikeja: { lat: 6.6018, lon: 3.3515, label: "Ikeja, Lagos" },
  abuja: { lat: 9.0765, lon: 7.3986, label: "Abuja" },
  "port harcourt": { lat: 4.8156, lon: 7.0498, label: "Port Harcourt" },
  kano: { lat: 12.0022, lon: 8.592, label: "Kano" },
  ibadan: { lat: 7.3775, lon: 3.947, label: "Ibadan" },
  onitsha: { lat: 6.1498, lon: 6.7857, label: "Onitsha" },
  kaduna: { lat: 10.5105, lon: 7.4165, label: "Kaduna" },
  benin: { lat: 6.335, lon: 5.6037, label: "Benin City" },
  "benin city": { lat: 6.335, lon: 5.6037, label: "Benin City" },
  accra: { lat: 5.6037, lon: -0.187, label: "Accra" },
  tema: { lat: 5.6698, lon: -0.0166, label: "Tema Port" },
  nairobi: { lat: -1.2921, lon: 36.8219, label: "Nairobi" },
  mombasa: { lat: -4.0435, lon: 39.6682, label: "Mombasa" },
  johannesburg: { lat: -26.2041, lon: 28.0473, label: "Johannesburg" },
  durban: { lat: -29.8587, lon: 31.0218, label: "Durban" },
  rotterdam: { lat: 51.9244, lon: 4.4777, label: "Rotterdam" },
  hamburg: { lat: 53.5511, lon: 9.9937, label: "Hamburg" },
  munich: { lat: 48.1351, lon: 11.582, label: "Munich" },
  antwerp: { lat: 51.2194, lon: 4.4025, label: "Antwerp" },
  london: { lat: 51.5074, lon: -0.1278, label: "London" },
  dubai: { lat: 25.2048, lon: 55.2708, label: "Dubai" },
  singapore: { lat: 1.3521, lon: 103.8198, label: "Singapore" },
  chicago: { lat: 41.8781, lon: -87.6298, label: "Chicago" },
  dallas: { lat: 32.7767, lon: -96.797, label: "Dallas" },
  atlanta: { lat: 33.749, lon: -84.388, label: "Atlanta" },
  "los angeles": { lat: 34.0522, lon: -118.2437, label: "Los Angeles" },
  "new york": { lat: 40.7128, lon: -74.006, label: "New York" },
  houston: { lat: 29.7604, lon: -95.3698, label: "Houston" },
  savannah: { lat: 32.0809, lon: -81.0912, label: "Savannah" },
};

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function resolveCityCoordinates(
  cityName: string | null | undefined,
  locations: LocationRow[] = [],
): GeoTarget | null {
  const cleaned = (cityName ?? "").trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();

  for (const loc of locations) {
    const lat = loc.latitude !== null ? Number(loc.latitude) : NaN;
    const lon = loc.longitude !== null ? Number(loc.longitude) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const locCity = (loc.city ?? "").trim().toLowerCase();
    const locName = (loc.name ?? "").trim().toLowerCase();
    const locCode = (loc.code ?? "").trim().toLowerCase();
    if (
      locCity === lower ||
      locCode === lower ||
      locName === lower ||
      (locCity && (lower.includes(locCity) || locCity.includes(lower)))
    ) {
      return {
        lat,
        lon,
        label: loc.city ? `${loc.name} (${loc.city})` : loc.name,
        city: loc.city ?? cleaned,
      };
    }
  }

  const direct = KNOWN_LOGISTICS_CITY_COORDS[lower];
  if (direct) {
    return {
      lat: direct.lat,
      lon: direct.lon,
      label: direct.label,
      city: direct.label,
    };
  }

  for (const [key, coords] of Object.entries(KNOWN_LOGISTICS_CITY_COORDS)) {
    if (lower.includes(key) || key.includes(lower)) {
      return {
        lat: coords.lat,
        lon: coords.lon,
        label: coords.label,
        city: coords.label,
      };
    }
  }

  return null;
}

export function normalizeDutyStatus(
  driver: Pick<DriverRow, "duty_status" | "assigned_to">,
): DriverDutyStatus {
  const raw = (driver.duty_status ?? "").toUpperCase();
  if (
    raw === "AVAILABLE" ||
    raw === "ON_ROUTE" ||
    raw === "RESTING" ||
    raw === "OFF_DUTY"
  ) {
    return raw;
  }
  return driver.assigned_to ? "ON_ROUTE" : "AVAILABLE";
}

export function parseNumericCoord(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export function getDriverCoordinates(
  driver: DriverRow,
  locations: LocationRow[] = [],
): { lat: number; lon: number; inferredFromCity: boolean } | null {
  const lat = parseNumericCoord(driver.current_lat);
  const lon = parseNumericCoord(driver.current_lon);
  if (
    lat !== null &&
    lon !== null &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  ) {
    return { lat, lon, inferredFromCity: false };
  }
  if (driver.current_city) {
    const resolved = resolveCityCoordinates(driver.current_city, locations);
    if (resolved) {
      return { lat: resolved.lat, lon: resolved.lon, inferredFromCity: true };
    }
  }
  return null;
}

export function findNearbyDrivers(
  drivers: DriverRow[],
  target: GeoTarget,
  filters: NearbyDriverFilter = {},
  locations: LocationRow[] = [],
): NearbyDriverMatch[] {
  const maxRadiusKm =
    typeof filters.maxRadiusKm === "number" && Number.isFinite(filters.maxRadiusKm)
      ? Math.max(1, filters.maxRadiusKm)
      : 500;
  const minHosDriveHours =
    typeof filters.minHosDriveHours === "number" &&
    Number.isFinite(filters.minHosDriveHours)
      ? Math.max(0, filters.minHosDriveHours)
      : 2;

  const matches: NearbyDriverMatch[] = [];

  for (const driver of drivers) {
    if (driver.active === false) continue;

    const coords = getDriverCoordinates(driver, locations);
    if (!coords) continue;

    const straightKm = haversineDistanceKm(
      target.lat,
      target.lon,
      coords.lat,
      coords.lon,
    );
    const distanceKm = Math.round(straightKm * 10) / 10;
    if (distanceKm > maxRadiusKm) continue;

    const roadDistanceKm = Math.round(straightKm * ROAD_CIRCUITY_FACTOR * 10) / 10;
    const etaMinutes = Math.max(
      5,
      Math.round((roadDistanceKm / AVG_APPROACH_SPEED_KPH) * 60),
    );

    const dutyStatus = normalizeDutyStatus(driver);
    const hosDrive =
      typeof driver.hos_drive_remaining_hours === "number" &&
      Number.isFinite(driver.hos_drive_remaining_hours)
        ? driver.hos_drive_remaining_hours
        : 9.5;
    const hosDuty =
      typeof driver.hos_duty_remaining_hours === "number" &&
      Number.isFinite(driver.hos_duty_remaining_hours)
        ? driver.hos_duty_remaining_hours
        : 12.0;

    const licenceDays =
      driver.days_to_expiry !== null &&
      driver.days_to_expiry !== undefined &&
      String(driver.days_to_expiry).trim() !== "" &&
      Number.isFinite(Number(driver.days_to_expiry))
        ? Number(driver.days_to_expiry)
        : null;

    const blockingReasons: string[] = [];
    const warnings: string[] = [];

    if (licenceDays !== null && licenceDays < 0) {
      blockingReasons.push("Driver licence expired");
    } else if (licenceDays !== null && licenceDays <= 30) {
      warnings.push(`Licence expires in ${licenceDays}d`);
    }

    if (dutyStatus !== "AVAILABLE" || driver.assigned_to) {
      blockingReasons.push(
        driver.assigned_to
          ? `Assigned to ${driver.assigned_to}`
          : `Status is ${dutyStatus.replace(/_/g, " ").toLowerCase()}`,
      );
    }

    const approachHours = etaMinutes / 60;
    if (hosDrive < Math.max(minHosDriveHours, approachHours)) {
      blockingReasons.push(
        `Insufficient HOS drive clock (${hosDrive.toFixed(1)}h left)`,
      );
    } else if (hosDrive < 4) {
      warnings.push(`Low HOS drive clock (${hosDrive.toFixed(1)}h left)`);
    }

    if (hosDuty < Math.max(minHosDriveHours, approachHours)) {
      blockingReasons.push(
        `Insufficient HOS on-duty clock (${hosDuty.toFixed(1)}h left)`,
      );
    }

    if (filters.requireHazmat && !driver.hazmat_certified) {
      blockingReasons.push("Not hazmat certified");
    }

    const driverReefer =
      Boolean(driver.reefer_capable) ||
      (driver.equipment_type ?? "").toUpperCase() === "REEFER";
    if (filters.requireReefer && !driverReefer) {
      blockingReasons.push("No reefer unit");
    }

    if (
      typeof filters.minPayloadKg === "number" &&
      filters.minPayloadKg > 0 &&
      typeof driver.max_payload_kg === "number" &&
      driver.max_payload_kg > 0 &&
      driver.max_payload_kg < filters.minPayloadKg
    ) {
      blockingReasons.push(
        `Payload limit ${driver.max_payload_kg.toLocaleString()} kg < ${filters.minPayloadKg.toLocaleString()} kg`,
      );
    }

    if (
      filters.equipmentType &&
      driver.equipment_type &&
      driver.equipment_type.toUpperCase() !== filters.equipmentType.toUpperCase()
    ) {
      blockingReasons.push(`Equipment is ${driver.equipment_type}`);
    }

    if (coords.inferredFromCity) {
      warnings.push("Position inferred from city (no live GPS ping)");
    } else if (driver.last_ping_at) {
      const pingAgeMin = Math.round(
        (Date.now() - new Date(driver.last_ping_at).getTime()) / 60_000,
      );
      if (pingAgeMin > 120) {
        warnings.push(`GPS ping stale (${Math.round(pingAgeMin / 60)}h ago)`);
      }
    }

    const eligible = blockingReasons.length === 0;

    if (filters.onlyAvailable && (dutyStatus !== "AVAILABLE" || driver.assigned_to)) {
      continue;
    }
    if (
      filters.requireValidLicence &&
      licenceDays !== null &&
      licenceDays < 0
    ) {
      continue;
    }
    if (filters.requireHazmat && !driver.hazmat_certified) {
      continue;
    }
    if (filters.requireReefer && !driverReefer) {
      continue;
    }

    // Deterministic 0-100 dispatch readiness & proximity score
    const proximityScore = Math.max(0, 55 * (1 - Math.min(distanceKm, maxRadiusKm) / maxRadiusKm));
    const availabilityScore = dutyStatus === "AVAILABLE" && !driver.assigned_to ? 20 : 0;
    const hosScore = Math.min(15, (hosDrive / 11) * 15);
    const complianceScore =
      licenceDays !== null && licenceDays < 0
        ? 0
        : licenceDays !== null && licenceDays <= 30
          ? 6
          : 10;
    const penalty = eligible ? 0 : 25;
    const matchScore = Math.max(
      1,
      Math.min(
        100,
        Math.round(
          proximityScore + availabilityScore + hosScore + complianceScore - penalty,
        ),
      ),
    );

    matches.push({
      driver,
      lat: coords.lat,
      lon: coords.lon,
      distanceKm,
      roadDistanceKm,
      etaMinutes,
      dutyStatus,
      hosDriveRemainingHours: hosDrive,
      hosDutyRemainingHours: hosDuty,
      licenceDaysRemaining: licenceDays,
      eligible,
      blockingReasons,
      warnings,
      matchScore,
    });
  }

  return matches.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return b.matchScore - a.matchScore;
  });
}

/**
 * Computes live logistics company operational readiness metrics:
 * - Driver GPS coverage, licence compliance, and HOS clock readiness
 * - Dock detention & dwell-time risk (> 2h free-time threshold on active pickups/staging)
 * - Unverified e-BOL / e-POD billing blockers
 */
export function computeLogisticsReadiness({
  drivers,
  shipments,
  documents = [],
  nowMs = Date.now(),
}: {
  drivers: DriverRow[];
  shipments: ShipmentRow[];
  documents?: DocumentRow[];
  nowMs?: number;
}): LogisticsReadinessReport {
  const activeDrivers = drivers.filter((d) => d.active !== false);
  let driversWithGps = 0;
  let driversAvailable = 0;
  let driversDispatchReady = 0;
  let driversExpiredLicence = 0;
  let driversExpiringSoon = 0;
  let driversLowHos = 0;

  for (const d of activeDrivers) {
    const lat = parseNumericCoord(d.current_lat);
    const lon = parseNumericCoord(d.current_lon);
    if (lat !== null && lon !== null) driversWithGps += 1;

    const status = normalizeDutyStatus(d);
    const available = status === "AVAILABLE" && !d.assigned_to;
    if (available) driversAvailable += 1;

    const days =
      d.days_to_expiry !== null && Number.isFinite(Number(d.days_to_expiry))
        ? Number(d.days_to_expiry)
        : null;
    const expired = days !== null && days < 0;
    if (expired) driversExpiredLicence += 1;
    else if (days !== null && days <= 30) driversExpiringSoon += 1;

    const hos =
      typeof d.hos_drive_remaining_hours === "number" &&
      Number.isFinite(d.hos_drive_remaining_hours)
        ? d.hos_drive_remaining_hours
        : 9.5;
    if (hos < 2.5) driversLowHos += 1;

    if (available && !expired && hos >= 2.5) {
      driversDispatchReady += 1;
    }
  }

  const detentionRisks: DetentionRiskItem[] = [];
  let unassignedActiveShipments = 0;

  const activeShipments = shipments.filter(
    (s) => !["CLOSED", "CANCELLED", "FAILED", "DELIVERED", "POD_VERIFIED"].includes(s.state),
  );

  for (const s of activeShipments) {
    const plan = (s.plan ?? {}) as Record<string, unknown>;
    const hasDriver = Boolean(plan.assigned_driver_id || plan.assigned_driver_name);
    if (["ALLOCATED", "PLANNED", "SOURCING", "BOOKED"].includes(s.state) && !hasDriver) {
      unassignedActiveShipments += 1;
    }

    const updatedMs = new Date(s.updated_at).getTime();
    if (!Number.isFinite(updatedMs)) continue;
    const hoursSinceUpdate = Math.max(0, (nowMs - updatedMs) / 3_600_000);

    // Dock detention / dwell risk: BOOKED or EXCEPTION or IN_TRANSIT without movement beyond threshold
    if (
      (s.state === "BOOKED" && hoursSinceUpdate >= DETENTION_FREE_TIME_HOURS) ||
      (s.state === "IN_TRANSIT" && hoursSinceUpdate >= 6) ||
      (s.state === "EXCEPTION" && hoursSinceUpdate >= 1.5)
    ) {
      const exposureMinutes = Math.max(
        0,
        Math.round((hoursSinceUpdate - DETENTION_FREE_TIME_HOURS) * 60),
      );
      const originCity =
        typeof s.origin?.city === "string" ? s.origin.city : null;
      detentionRisks.push({
        reference: s.reference,
        state: s.state,
        city: originCity,
        hoursSinceUpdate: Math.round(hoursSinceUpdate * 10) / 10,
        estimatedExposureMinutes: exposureMinutes,
        severity:
          hoursSinceUpdate >= 4 || s.state === "EXCEPTION" ? "HIGH" : "MEDIUM",
        reason:
          s.state === "BOOKED"
            ? `Awaiting pickup ${hoursSinceUpdate.toFixed(1)}h (> ${DETENTION_FREE_TIME_HOURS}h free-time threshold)`
            : s.state === "EXCEPTION"
              ? `Open disruption dwell ${hoursSinceUpdate.toFixed(1)}h`
              : `No transit update for ${hoursSinceUpdate.toFixed(1)}h`,
      });
    }
  }

  const unverifiedPodBolCount = documents.filter(
    (doc) =>
      !doc.verified_at &&
      /pod|bol|waybill|cmr|delivery/i.test(`${doc.kind} ${doc.filename}`),
  ).length;

  return {
    driversTotal: activeDrivers.length,
    driversWithGps,
    driversAvailable,
    driversDispatchReady,
    driversExpiredLicence,
    driversExpiringSoon,
    driversLowHos,
    detentionRisks: detentionRisks
      .sort((a, b) => b.hoursSinceUpdate - a.hoursSinceUpdate)
      .slice(0, 10),
    unverifiedPodBolCount,
    unassignedActiveShipments,
  };
}

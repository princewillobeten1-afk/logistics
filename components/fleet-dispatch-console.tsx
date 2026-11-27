"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Crosshair,
  Loader2,
  MapPin,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KNOWN_LOGISTICS_CITY_COORDS,
  type GeoTarget,
  type LogisticsReadinessReport,
  type NearbyDriverMatch,
} from "@/lib/driver-dispatch";
import type { DriverRow, LocationRow } from "@/lib/queries";

export interface DispatchShipmentOption {
  id: string;
  reference: string;
  state: string;
  originCity: string | null;
  destinationCity: string | null;
  hazmat: boolean;
  reefer: boolean;
  weightKg: number | null;
  assignedDriverName: string | null;
}

interface NearbyApiResponse {
  target: GeoTarget | null;
  matches: NearbyDriverMatch[];
  drivers: DriverRow[];
  locations: LocationRow[];
  activeShipments: DispatchShipmentOption[];
  readiness: LogisticsReadinessReport;
  fetchedAt: string;
  error?: string;
}

const CITY_PRESETS = Object.entries(KNOWN_LOGISTICS_CITY_COORDS)
  .filter(([key]) => !["benin", "apapa", "ikeja"].includes(key))
  .map(([, val]) => val);

const RADIUS_OPTIONS = [50, 150, 300, 500, 1000] as const;

const EQUIPMENT_OPTIONS = [
  { value: "DRY_VAN", label: "Dry van" },
  { value: "REEFER", label: "Reefer (cold chain)" },
  { value: "FLATBED", label: "Flatbed" },
  { value: "BOX_TRUCK", label: "Box truck" },
  { value: "TANKER", label: "Tanker" },
  { value: "CONTAINER_CHASSIS", label: "Container chassis" },
] as const;

function formatEta(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function dutyTone(status: string): string {
  if (status === "AVAILABLE") return "ok";
  if (status === "ON_ROUTE") return "warn";
  return "neutral";
}

function dutyLabel(status: string): string {
  return status.replace(/_/g, " ").toLowerCase();
}

export function FleetDispatchConsole({
  initialDrivers,
  initialLocations,
  initialShipments,
  initialReadiness,
}: {
  initialDrivers: DriverRow[];
  initialLocations: LocationRow[];
  initialShipments: DispatchShipmentOption[];
  initialReadiness: LogisticsReadinessReport;
}) {
  const router = useRouter();

  const [drivers, setDrivers] = useState<DriverRow[]>(initialDrivers);
  const [locations, setLocations] = useState<LocationRow[]>(initialLocations);
  const [shipments, setShipments] =
    useState<DispatchShipmentOption[]>(initialShipments);
  const [readiness, setReadiness] =
    useState<LogisticsReadinessReport>(initialReadiness);

  // Target selection state
  const [selectedShipmentRef, setSelectedShipmentRef] = useState<string>(
    initialShipments.find((s) => !s.assignedDriverName)?.reference ??
      initialShipments[0]?.reference ??
      "",
  );
  const [selectedHubId, setSelectedHubId] = useState<string>("");
  const [cityQuery, setCityQuery] = useState<string>("");
  const [customLat, setCustomLat] = useState<string>("");
  const [customLon, setCustomLon] = useState<string>("");
  const [radiusKm, setRadiusKm] = useState<number>(300);

  // Compliance & equipment filters
  const [onlyAvailable, setOnlyAvailable] = useState<boolean>(false);
  const [requireValidLicence, setRequireValidLicence] = useState<boolean>(true);
  const [requireHazmat, setRequireHazmat] = useState<boolean>(false);
  const [requireReefer, setRequireReefer] = useState<boolean>(false);

  // Search results & status
  const [target, setTarget] = useState<GeoTarget | null>(null);
  const [matches, setMatches] = useState<NearbyDriverMatch[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [locatingGps, setLocatingGps] = useState<boolean>(false);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Collapsible forms for Driver Registration and Live GPS Check-in
  const [activeDrawer, setActiveDrawer] = useState<"none" | "register" | "gps">(
    "none",
  );
  const [submittingForm, setSubmittingForm] = useState<boolean>(false);

  // Register driver form
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regLicence, setRegLicence] = useState("");
  const [regExpiry, setRegExpiry] = useState(() =>
    new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
  );
  const [regCity, setRegCity] = useState(
    initialLocations[0]?.city ?? "Lagos",
  );
  const [regLat, setRegLat] = useState(
    initialLocations[0]?.latitude ? String(initialLocations[0].latitude) : "6.5244",
  );
  const [regLon, setRegLon] = useState(
    initialLocations[0]?.longitude ? String(initialLocations[0].longitude) : "3.3792",
  );
  const [regVehicle, setRegVehicle] = useState("");
  const [regEquipment, setRegEquipment] = useState<string>("DRY_VAN");
  const [regPayload, setRegPayload] = useState<string>("18000");
  const [regHosDrive, setRegHosDrive] = useState<string>("9.5");
  const [regHosDuty, setRegHosDuty] = useState<string>("12.0");
  const [regHazmat, setRegHazmat] = useState<boolean>(false);
  const [regReefer, setRegReefer] = useState<boolean>(false);

  // GPS Check-in form
  const [gpsDriverId, setGpsDriverId] = useState<string>(
    initialDrivers[0]?.id ?? "",
  );
  const [gpsCity, setGpsCity] = useState<string>(
    initialDrivers[0]?.current_city ?? initialLocations[0]?.city ?? "Lagos",
  );
  const [gpsLat, setGpsLat] = useState<string>(
    initialDrivers[0]?.current_lat ?? "6.5244",
  );
  const [gpsLon, setGpsLon] = useState<string>(
    initialDrivers[0]?.current_lon ?? "3.3792",
  );
  const [gpsStatus, setGpsStatus] = useState<string>(
    initialDrivers[0]?.duty_status ?? "AVAILABLE",
  );
  const [gpsHosDrive, setGpsHosDrive] = useState<string>(
    String(initialDrivers[0]?.hos_drive_remaining_hours ?? 9.5),
  );
  const [gpsHosDuty, setGpsHosDuty] = useState<string>(
    String(initialDrivers[0]?.hos_duty_remaining_hours ?? 12.0),
  );

  const selectedShipment = useMemo(
    () => shipments.find((s) => s.reference === selectedShipmentRef) ?? null,
    [shipments, selectedShipmentRef],
  );

  const fetchNearby = useCallback(
    async (overrides?: {
      shipmentRef?: string;
      city?: string;
      lat?: string;
      lon?: string;
      radius?: number;
      hazmat?: boolean;
      reefer?: boolean;
    }) => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const sp = new URLSearchParams();
        const ref = overrides?.shipmentRef ?? selectedShipmentRef;
        const city = overrides?.city ?? cityQuery;
        const lat = overrides?.lat ?? customLat;
        const lon = overrides?.lon ?? customLon;
        const rad = overrides?.radius ?? radiusKm;
        const hz = overrides?.hazmat ?? requireHazmat;
        const rf = overrides?.reefer ?? requireReefer;

        if (ref) sp.set("shipmentRef", ref);
        if (city.trim()) sp.set("city", city.trim());
        if (lat.trim() && lon.trim()) {
          sp.set("lat", lat.trim());
          sp.set("lon", lon.trim());
        }
        sp.set("radiusKm", String(rad));
        if (onlyAvailable) sp.set("onlyAvailable", "1");
        if (requireValidLicence) sp.set("requireValidLicence", "1");
        if (hz) sp.set("hazmat", "1");
        if (rf) sp.set("reefer", "1");

        const res = await fetch(`/api/fleet/nearby-drivers?${sp.toString()}`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as NearbyApiResponse;
        if (!res.ok) {
          throw new Error(data.error || "Failed to search nearby drivers.");
        }
        setTarget(data.target);
        setMatches(Array.isArray(data.matches) ? data.matches : []);
        if (Array.isArray(data.drivers)) setDrivers(data.drivers);
        if (Array.isArray(data.locations)) setLocations(data.locations);
        if (Array.isArray(data.activeShipments))
          setShipments(data.activeShipments);
        if (data.readiness) setReadiness(data.readiness);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Could not load nearby drivers.",
        );
      } finally {
        setLoading(false);
      }
    },
    [
      selectedShipmentRef,
      cityQuery,
      customLat,
      customLon,
      radiusKm,
      onlyAvailable,
      requireValidLicence,
      requireHazmat,
      requireReefer,
    ],
  );

  useEffect(() => {
    void fetchNearby();
  }, [fetchNearby]);

  function handleShipmentChange(ref: string) {
    setSelectedShipmentRef(ref);
    setSelectedHubId("");
    setCustomLat("");
    setCustomLon("");
    setCityQuery("");
    const found = shipments.find((s) => s.reference === ref);
    if (found) {
      setRequireHazmat(found.hazmat);
      setRequireReefer(found.reefer);
    }
  }

  function handleHubChange(locId: string) {
    setSelectedHubId(locId);
    setSelectedShipmentRef("");
    const loc = locations.find((l) => l.id === locId);
    if (loc) {
      setCityQuery(loc.city ?? loc.name);
      setCustomLat(loc.latitude ? String(loc.latitude) : "");
      setCustomLon(loc.longitude ? String(loc.longitude) : "");
    }
  }

  function handleUseMyGps() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setErrorMsg("Browser geolocation is unavailable on this device.");
      return;
    }
    setLocatingGps(true);
    setErrorMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latStr = pos.coords.latitude.toFixed(5);
        const lonStr = pos.coords.longitude.toFixed(5);
        setSelectedShipmentRef("");
        setSelectedHubId("");
        setCityQuery("Current device position");
        setCustomLat(latStr);
        setCustomLon(lonStr);
        setLocatingGps(false);
      },
      (geoErr) => {
        setLocatingGps(false);
        setErrorMsg(
          geoErr.message ||
            "Location access denied. Select a hub, shipment, or city instead.",
        );
      },
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }

  function applyCityPresetToRegister(cityLabel: string) {
    setRegCity(cityLabel);
    const preset = CITY_PRESETS.find(
      (c) => c.label.toLowerCase() === cityLabel.toLowerCase(),
    );
    if (preset) {
      setRegLat(String(preset.lat));
      setRegLon(String(preset.lon));
    }
  }

  function applyCityPresetToGps(cityLabel: string) {
    setGpsCity(cityLabel);
    const preset = CITY_PRESETS.find(
      (c) => c.label.toLowerCase() === cityLabel.toLowerCase(),
    );
    if (preset) {
      setGpsLat(String(preset.lat));
      setGpsLon(String(preset.lon));
    }
  }

  function handleSelectGpsDriver(id: string) {
    setGpsDriverId(id);
    const d = drivers.find((item) => item.id === id);
    if (d) {
      setGpsCity(d.current_city ?? "");
      setGpsLat(d.current_lat ?? "");
      setGpsLon(d.current_lon ?? "");
      setGpsStatus(d.duty_status ?? (d.assigned_to ? "ON_ROUTE" : "AVAILABLE"));
      setGpsHosDrive(String(d.hos_drive_remaining_hours ?? 9.5));
      setGpsHosDuty(String(d.hos_duty_remaining_hours ?? 12.0));
    }
  }

  async function handleDispatch(driverId: string, driverName: string) {
    if (!selectedShipmentRef) {
      setErrorMsg("Select an active shipment in the target bar before dispatching a driver.");
      return;
    }
    setDispatchingId(driverId);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/fleet/nearby-drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "dispatch_driver",
          driverId,
          shipmentRef: selectedShipmentRef,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Dispatch blocked.");
      }
      setSuccessMsg(
        data.message ?? `Dispatched ${driverName} to ${selectedShipmentRef}.`,
      );
      await fetchNearby();
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Dispatch failed.");
    } finally {
      setDispatchingId(null);
    }
  }

  async function handleRegisterDriver(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingForm(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/fleet/nearby-drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register_driver",
          name: regName,
          phone: regPhone,
          licenceNumber: regLicence,
          licenceExpiry: regExpiry,
          currentCity: regCity,
          lat: regLat ? Number(regLat) : null,
          lon: regLon ? Number(regLon) : null,
          vehicleRegistration: regVehicle,
          equipmentType: regEquipment,
          maxPayloadKg: Number(regPayload) || 18000,
          hosDriveRemainingHours: Number(regHosDrive),
          hosDutyRemainingHours: Number(regHosDuty),
          hazmatCertified: regHazmat,
          reeferCapable: regReefer || regEquipment === "REEFER",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Could not register driver.");
      }
      setSuccessMsg(data.message ?? "Driver registered.");
      setRegName("");
      setRegPhone("");
      setRegLicence("");
      setRegVehicle("");
      setActiveDrawer("none");
      await fetchNearby();
      router.refresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not register driver.",
      );
    } finally {
      setSubmittingForm(false);
    }
  }

  async function handleUpdateGps(e: React.FormEvent) {
    e.preventDefault();
    if (!gpsDriverId) return;
    setSubmittingForm(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/fleet/nearby-drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_gps",
          driverId: gpsDriverId,
          currentCity: gpsCity,
          lat: gpsLat ? Number(gpsLat) : null,
          lon: gpsLon ? Number(gpsLon) : null,
          dutyStatus: gpsStatus,
          hosDriveRemainingHours: Number(gpsHosDrive),
          hosDutyRemainingHours: Number(gpsHosDuty),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Could not update driver telemetry.");
      }
      setSuccessMsg(data.message ?? "Driver telemetry updated.");
      setActiveDrawer("none");
      await fetchNearby();
      router.refresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not update GPS.",
      );
    } finally {
      setSubmittingForm(false);
    }
  }

  return (
    <section className="panel" aria-label="Nearby driver locator and dispatch">
      <header>
        <div>
          <h2>Nearby Driver Locator &amp; Dispatch</h2>
          <span className="hint">
            Geospatial proximity, HOS clocks, licence gating, and equipment match
          </span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() =>
              setActiveDrawer(activeDrawer === "register" ? "none" : "register")
            }
          >
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
            <span>Register driver</span>
          </button>
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() => {
              if (!gpsDriverId && drivers[0]) {
                handleSelectGpsDriver(drivers[0].id);
              }
              setActiveDrawer(activeDrawer === "gps" ? "none" : "gps");
            }}
            disabled={drivers.length === 0}
          >
            <Radio size={13} strokeWidth={2} aria-hidden="true" />
            <span>Update GPS / HOS</span>
          </button>
          <button
            type="button"
            className="panel-refresh-btn"
            onClick={() => void fetchNearby()}
            disabled={loading}
          >
            <RefreshCw
              size={13}
              strokeWidth={2}
              className={loading ? "spin" : undefined}
              aria-hidden="true"
            />
            <span>{loading ? "Locating…" : "Refresh"}</span>
          </button>
        </div>
      </header>

      <div className="body stack-md">
        {/* Operational Readiness Strip */}
        <dl className="fleet-readiness-strip">
          <div>
            <dt>GPS-tracked</dt>
            <dd className="num">
              {readiness.driversWithGps} / {readiness.driversTotal}
            </dd>
          </div>
          <div>
            <dt>Dispatch-ready (HOS + CDL)</dt>
            <dd className="num">{readiness.driversDispatchReady}</dd>
          </div>
          <div>
            <dt>Detention / dwell risks</dt>
            <dd
              className={`num${readiness.detentionRisks.length > 0 ? " text-warn" : ""}`}
            >
              {readiness.detentionRisks.length}
            </dd>
          </div>
          <div>
            <dt>Unverified e-BOL / e-POD</dt>
            <dd
              className={`num${readiness.unverifiedPodBolCount > 0 ? " text-warn" : ""}`}
            >
              {readiness.unverifiedPodBolCount}
            </dd>
          </div>
          <div>
            <dt>Unassigned active loads</dt>
            <dd className="num">{readiness.unassignedActiveShipments}</dd>
          </div>
        </dl>

        {readiness.detentionRisks.length > 0 ? (
          <div className="banner" data-tone="warn" style={{ marginBottom: 0 }}>
            <strong>Detention &amp; dwell watch:</strong>{" "}
            {readiness.detentionRisks.slice(0, 3).map((risk, idx) => (
              <span key={risk.reference}>
                {idx > 0 ? " · " : ""}
                <Link
                  href={`/shipments/${risk.reference}`}
                  className="font-mono underline"
                >
                  {risk.reference}
                </Link>{" "}
                ({risk.reason})
              </span>
            ))}
          </div>
        ) : null}

        {errorMsg ? (
          <div className="panel-inline-error" role="alert">
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
            <span>{errorMsg}</span>
          </div>
        ) : null}

        {successMsg ? (
          <div className="banner" data-tone="ok" style={{ marginBottom: 0 }}>
            <CheckCircle2
              size={14}
              strokeWidth={2}
              style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }}
              aria-hidden="true"
            />
            {successMsg}
          </div>
        ) : null}

        {/* Register Driver Collapsible Drawer */}
        {activeDrawer === "register" ? (
          <form onSubmit={handleRegisterDriver} className="fleet-drawer">
            <div className="fleet-drawer-head">
              <strong>Register driver with GPS &amp; HOS clock</strong>
              <button
                type="button"
                className="btn-ghost-sm"
                onClick={() => setActiveDrawer("none")}
              >
                Close
              </button>
            </div>
            <div className="fleet-form-grid">
              <label className="fleet-field">
                <span>Full name *</span>
                <input
                  type="text"
                  required
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="e.g. Chinedu Okafor"
                />
              </label>
              <label className="fleet-field">
                <span>Phone</span>
                <input
                  type="tel"
                  value={regPhone}
                  onChange={(e) => setRegPhone(e.target.value)}
                  placeholder="+234 803 000 0000"
                />
              </label>
              <label className="fleet-field">
                <span>Licence / CDL number</span>
                <input
                  type="text"
                  value={regLicence}
                  onChange={(e) => setRegLicence(e.target.value)}
                  placeholder="CDL-NG-88412"
                />
              </label>
              <label className="fleet-field">
                <span>Licence expiry</span>
                <input
                  type="date"
                  value={regExpiry}
                  onChange={(e) => setRegExpiry(e.target.value)}
                />
              </label>
              <label className="fleet-field">
                <span>Current city (preset auto-fills GPS)</span>
                <input
                  type="text"
                  list="fleet-city-presets"
                  value={regCity}
                  onChange={(e) => applyCityPresetToRegister(e.target.value)}
                  placeholder="Lagos, Rotterdam, Chicago…"
                />
              </label>
              <label className="fleet-field">
                <span>Latitude / Longitude</span>
                <div className="fleet-coord-pair">
                  <input
                    type="number"
                    step="0.0001"
                    value={regLat}
                    onChange={(e) => setRegLat(e.target.value)}
                    placeholder="Lat"
                  />
                  <input
                    type="number"
                    step="0.0001"
                    value={regLon}
                    onChange={(e) => setRegLon(e.target.value)}
                    placeholder="Lon"
                  />
                </div>
              </label>
              <label className="fleet-field">
                <span>Vehicle registration</span>
                <input
                  type="text"
                  value={regVehicle}
                  onChange={(e) => setRegVehicle(e.target.value)}
                  placeholder="KJA-412-XY"
                />
              </label>
              <label className="fleet-field">
                <span>Equipment type</span>
                <select
                  value={regEquipment}
                  onChange={(e) => {
                    setRegEquipment(e.target.value);
                    if (e.target.value === "REEFER") setRegReefer(true);
                  }}
                >
                  {EQUIPMENT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fleet-field">
                <span>Max payload (kg)</span>
                <input
                  type="number"
                  min={500}
                  max={60000}
                  value={regPayload}
                  onChange={(e) => setRegPayload(e.target.value)}
                />
              </label>
              <label className="fleet-field">
                <span>HOS Drive / Duty remaining (hrs)</span>
                <div className="fleet-coord-pair">
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={11}
                    value={regHosDrive}
                    onChange={(e) => setRegHosDrive(e.target.value)}
                    aria-label="HOS drive hours remaining"
                  />
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={14}
                    value={regHosDuty}
                    onChange={(e) => setRegHosDuty(e.target.value)}
                    aria-label="HOS on-duty hours remaining"
                  />
                </div>
              </label>
            </div>
            <div className="fleet-drawer-foot">
              <div className="fleet-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={regHazmat}
                    onChange={(e) => setRegHazmat(e.target.checked)}
                  />
                  <span>Hazmat certified</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={regReefer}
                    onChange={(e) => setRegReefer(e.target.checked)}
                  />
                  <span>Reefer / cold-chain unit</span>
                </label>
              </div>
              <button
                type="submit"
                className="btn-primary-sm"
                disabled={submittingForm}
              >
                {submittingForm ? (
                  <Loader2 size={13} className="spin" aria-hidden="true" />
                ) : (
                  <Plus size={13} aria-hidden="true" />
                )}
                <span>Save driver</span>
              </button>
            </div>
          </form>
        ) : null}

        {/* Update Live GPS / HOS Collapsible Drawer */}
        {activeDrawer === "gps" && drivers.length > 0 ? (
          <form onSubmit={handleUpdateGps} className="fleet-drawer">
            <div className="fleet-drawer-head">
              <strong>Live driver GPS &amp; HOS check-in</strong>
              <button
                type="button"
                className="btn-ghost-sm"
                onClick={() => setActiveDrawer("none")}
              >
                Close
              </button>
            </div>
            <div className="fleet-form-grid">
              <label className="fleet-field">
                <span>Driver</span>
                <select
                  value={gpsDriverId}
                  onChange={(e) => handleSelectGpsDriver(e.target.value)}
                >
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.current_city ?? "no city"})
                    </option>
                  ))}
                </select>
              </label>
              <label className="fleet-field">
                <span>Duty status</span>
                <select
                  value={gpsStatus}
                  onChange={(e) => setGpsStatus(e.target.value)}
                >
                  <option value="AVAILABLE">Available</option>
                  <option value="ON_ROUTE">On route</option>
                  <option value="RESTING">Resting (sleeper berth)</option>
                  <option value="OFF_DUTY">Off duty</option>
                </select>
              </label>
              <label className="fleet-field">
                <span>City / checkpoint</span>
                <input
                  type="text"
                  list="fleet-city-presets"
                  value={gpsCity}
                  onChange={(e) => applyCityPresetToGps(e.target.value)}
                  placeholder="Lagos, Ibadan, Abuja…"
                />
              </label>
              <label className="fleet-field">
                <span>GPS Lat / Lon</span>
                <div className="fleet-coord-pair">
                  <input
                    type="number"
                    step="0.0001"
                    value={gpsLat}
                    onChange={(e) => setGpsLat(e.target.value)}
                    placeholder="Lat"
                  />
                  <input
                    type="number"
                    step="0.0001"
                    value={gpsLon}
                    onChange={(e) => setGpsLon(e.target.value)}
                    placeholder="Lon"
                  />
                </div>
              </label>
              <label className="fleet-field">
                <span>HOS Drive / Duty remaining (hrs)</span>
                <div className="fleet-coord-pair">
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={11}
                    value={gpsHosDrive}
                    onChange={(e) => setGpsHosDrive(e.target.value)}
                  />
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={14}
                    value={gpsHosDuty}
                    onChange={(e) => setGpsHosDuty(e.target.value)}
                  />
                </div>
              </label>
            </div>
            <div className="fleet-drawer-foot">
              <span className="text-xs text-faint">
                Setting status to Available clears active shipment lock so the
                driver can accept a new load.
              </span>
              <button
                type="submit"
                className="btn-primary-sm"
                disabled={submittingForm}
              >
                {submittingForm ? (
                  <Loader2 size={13} className="spin" aria-hidden="true" />
                ) : (
                  <Radio size={13} aria-hidden="true" />
                )}
                <span>Push telemetry</span>
              </button>
            </div>
          </form>
        ) : null}

        <datalist id="fleet-city-presets">
          {CITY_PRESETS.map((c) => (
            <option key={c.label} value={c.label} />
          ))}
        </datalist>

        {/* Search & Target Controls */}
        <div className="fleet-locator-bar">
          <label className="fleet-field">
            <span>Dispatch for shipment</span>
            <select
              value={selectedShipmentRef}
              onChange={(e) => handleShipmentChange(e.target.value)}
            >
              <option value="">— Search without shipment —</option>
              {shipments.map((s) => (
                <option key={s.id} value={s.reference}>
                  {s.reference} · {s.originCity ?? "Origin"} →{" "}
                  {s.destinationCity ?? "Dest"}
                  {s.assignedDriverName
                    ? ` (Driver: ${s.assignedDriverName})`
                    : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="fleet-field">
            <span>Or hub / warehouse</span>
            <select
              value={selectedHubId}
              onChange={(e) => handleHubChange(e.target.value)}
            >
              <option value="">— Select network hub —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.city ?? l.code ?? l.type})
                </option>
              ))}
            </select>
          </label>

          <label className="fleet-field">
            <span>Or city / area</span>
            <div className="fleet-search-input">
              <Search size={13} strokeWidth={2} aria-hidden="true" />
              <input
                type="text"
                list="fleet-city-presets"
                value={cityQuery}
                onChange={(e) => {
                  setSelectedShipmentRef("");
                  setSelectedHubId("");
                  setCustomLat("");
                  setCustomLon("");
                  setCityQuery(e.target.value);
                }}
                placeholder="Lagos, Rotterdam, Dallas…"
              />
            </div>
          </label>

          <label className="fleet-field">
            <span>Search radius</span>
            <select
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
            >
              {RADIUS_OPTIONS.map((km) => (
                <option key={km} value={km}>
                  Within {km} km
                </option>
              ))}
            </select>
          </label>

          <div className="fleet-gps-btn-wrap">
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={handleUseMyGps}
              disabled={locatingGps}
            >
              {locatingGps ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : (
                <Crosshair size={13} strokeWidth={2} aria-hidden="true" />
              )}
              <span>Use my GPS</span>
            </button>
          </div>
        </div>

        {/* Compliance Filter Toggles */}
        <div className="fleet-filter-row">
          <div className="filters" style={{ marginBottom: 0 }}>
            <button
              type="button"
              data-active={onlyAvailable}
              onClick={() => setOnlyAvailable((v) => !v)}
            >
              Available only
            </button>
            <button
              type="button"
              data-active={requireValidLicence}
              onClick={() => setRequireValidLicence((v) => !v)}
            >
              Valid CDL only
            </button>
            <button
              type="button"
              data-active={requireHazmat}
              onClick={() => setRequireHazmat((v) => !v)}
            >
              Hazmat certified
            </button>
            <button
              type="button"
              data-active={requireReefer}
              onClick={() => setRequireReefer((v) => !v)}
            >
              Reefer unit
            </button>
          </div>
          {target ? (
            <span className="font-mono text-xs text-faint">
              <MapPin
                size={12}
                strokeWidth={2}
                style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }}
                aria-hidden="true"
              />
              {target.label} ({target.lat.toFixed(3)}, {target.lon.toFixed(3)}) ·{" "}
              {matches.length} driver{matches.length === 1 ? "" : "s"} in{" "}
              {radiusKm} km
            </span>
          ) : (
            <span className="text-xs text-faint">
              Enter a city, choose a hub/shipment, or click Use my GPS to rank
              nearby drivers.
            </span>
          )}
        </div>

        {/* Nearby Drivers Results Table */}
        {matches.length === 0 ? (
          <div className="empty" style={{ padding: "1.75rem 1rem" }}>
            <span className="empty-icon" aria-hidden="true">
              <Truck size={18} strokeWidth={1.75} />
            </span>
            <strong>
              {drivers.length === 0
                ? "No drivers registered yet"
                : "No drivers matched within this radius & filter set"}
            </strong>
            <div className="empty-hint">
              {drivers.length === 0
                ? "Click Register driver above (or sync from your TMS/ELD integration) to plot GPS-tracked drivers."
                : "Try expanding the search radius, clearing equipment filters, or updating driver GPS coordinates."}
            </div>
          </div>
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Nearby drivers ranked by proximity and readiness"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Driver &amp; Unit</th>
                  <th scope="col">Current position</th>
                  <th scope="col">Distance / ETA</th>
                  <th scope="col">Status</th>
                  <th scope="col">HOS Clock</th>
                  <th scope="col">Compliance</th>
                  <th scope="col">Score</th>
                  <th scope="col">Dispatch</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.driver.id}>
                    <td>
                      <div className="font-semibold">{m.driver.name}</div>
                      <div className="font-mono text-xs text-faint">
                        {m.driver.vehicle_registration ??
                          m.driver.equipment_type ??
                          "DRY_VAN"}
                        {m.driver.hazmat_certified ? " · HAZMAT" : ""}
                        {m.driver.reefer_capable ? " · REEFER" : ""}
                      </div>
                    </td>
                    <td>
                      <div>{m.driver.current_city ?? "GPS coordinates"}</div>
                      <div className="font-mono text-xs text-faint">
                        {m.lat.toFixed(3)}, {m.lon.toFixed(3)}
                      </div>
                    </td>
                    <td className="num">
                      <div className="font-semibold">
                        {m.roadDistanceKm} km road
                      </div>
                      <div className="text-xs text-faint">
                        ~{formatEta(m.etaMinutes)} approach ({m.distanceKm} km
                        air)
                      </div>
                    </td>
                    <td>
                      <span
                        className="status-tag"
                        data-tone={dutyTone(m.dutyStatus)}
                      >
                        {dutyLabel(m.dutyStatus)}
                      </span>
                      {m.driver.assigned_to ? (
                        <div className="font-mono text-xs text-faint">
                          <Link href={`/shipments/${m.driver.assigned_to}`}>
                            {m.driver.assigned_to}
                          </Link>
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      <div className="row-center" style={{ gap: "0.25rem" }}>
                        <Clock size={12} strokeWidth={2} aria-hidden="true" />
                        <span>{m.hosDriveRemainingHours.toFixed(1)}h drive</span>
                      </div>
                      <div className="text-xs text-faint">
                        {m.hosDutyRemainingHours.toFixed(1)}h duty left
                      </div>
                    </td>
                    <td className="text-xs">
                      {m.eligible ? (
                        <span className="fleet-compliance-ok">
                          <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
                          <span>Dispatch ready</span>
                        </span>
                      ) : (
                        <span className="fleet-compliance-block">
                          <ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />
                          <span>{m.blockingReasons.join(" · ")}</span>
                        </span>
                      )}
                      {m.warnings.length > 0 ? (
                        <div className="text-faint" style={{ marginTop: 2 }}>
                          {m.warnings.join(" · ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="num font-semibold">{m.matchScore}</td>
                    <td>
                      {selectedShipment ? (
                        <button
                          type="button"
                          className="btn-ghost-sm"
                          disabled={
                            !m.eligible || dispatchingId === m.driver.id
                          }
                          onClick={() =>
                            void handleDispatch(m.driver.id, m.driver.name)
                          }
                          title={
                            m.eligible
                              ? `Assign ${m.driver.name} to ${selectedShipment.reference}`
                              : m.blockingReasons.join("; ")
                          }
                        >
                          {dispatchingId === m.driver.id ? (
                            <Loader2 size={12} className="spin" aria-hidden="true" />
                          ) : (
                            <Send size={12} strokeWidth={2} aria-hidden="true" />
                          )}
                          <span>Dispatch</span>
                        </button>
                      ) : (
                        <span className="text-xs text-faint">
                          Select shipment
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

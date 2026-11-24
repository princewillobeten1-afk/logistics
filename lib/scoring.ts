/** Carrier scoring — DISPLAY ONLY.
 *
 *   30% cost · 25% on-time · 15% availability
 * · 10% damage · 10% route experience · 10% service
 *
 * `src/logistics/carriers/scoring.py` is canonical. It scores real quotes,
 * converts cost into the policy's base currency, applies the deadline on-time
 * floor, and stores the result on the quote row — and that stored value is
 * what the shipment page renders.
 *
 * What lives here is the weight table for the explainer on /carriers, plus a
 * quality-only score for carriers with no live quote to compare. Two
 * implementations of a spend decision would be free to drift, and the one
 * actually spending money would not be the one on screen.
 */

export const WEIGHTS = {
  cost: 0.3,
  onTime: 0.25,
  availability: 0.15,
  damage: 0.1,
  routeExperience: 0.1,
  service: 0.1,
} as const;

export type CarrierSignals = {
  onTimeRate: number | null;
  damageRate: number | null;
  availabilityRate: number | null;
  serviceScore: number | null;
  shipmentsCount: number | null;
  /** 0..1, where 1 is the cheapest quote in the set. Absent until quotes are in. */
  costScore?: number | null;
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Route experience from volume: 200+ shipments on a lane is full marks. */
export function experienceScore(shipments: number | null): number {
  if (shipments === null || shipments === undefined || !Number.isFinite(shipments) || shipments <= 0) {
    return 0;
  }
  return Math.min(1, shipments / 200);
}

/** Normalise quoted prices so the cheapest scores 1 and the dearest 0. */
export function costScores(amounts: number[]): number[] {
  if (amounts.length === 0) return [];
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return amounts.map(() => 0);
  }
  if (max === min) return amounts.map(() => 1);
  return amounts.map((a) => (max - a) / (max - min));
}

export type ScoreBreakdown = {
  total: number;
  /** Total over the weights actually applied, so a quality-only score is
   *  comparable against a full one. */
  normalised: number;
  applied: number;
  parts: { label: string; weight: number; value: number; contribution: number }[];
  costApplied: boolean;
};

export function scoreCarrier(signals: CarrierSignals): ScoreBreakdown {
  const parts: ScoreBreakdown["parts"] = [];
  let total = 0;
  let applied = 0;

  const add = (label: string, weight: number, value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const clamped = clampUnit(value);
    const contribution = weight * clamped;
    parts.push({ label, weight, value: clamped, contribution });
    total += contribution;
    applied += weight;
  };

  add("Cost", WEIGHTS.cost, signals.costScore);
  add("On-time", WEIGHTS.onTime, signals.onTimeRate);
  add("Availability", WEIGHTS.availability, signals.availabilityRate);
  // Damage is a rate where lower is better, so it inverts.
  add(
    "Damage",
    WEIGHTS.damage,
    signals.damageRate === null ||
      signals.damageRate === undefined ||
      !Number.isFinite(signals.damageRate)
      ? null
      : 1 - clampUnit(signals.damageRate),
  );
  add("Route experience", WEIGHTS.routeExperience, experienceScore(signals.shipmentsCount));
  add("Service", WEIGHTS.service, signals.serviceScore);

  const costApplied =
    signals.costScore !== null &&
    signals.costScore !== undefined &&
    Number.isFinite(signals.costScore);

  return {
    total,
    normalised: applied > 0 ? total / applied : 0,
    applied,
    parts,
    costApplied,
  };
}

export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

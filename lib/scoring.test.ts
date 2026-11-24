import assert from "node:assert/strict";
import test from "node:test";
import {
  WEIGHTS,
  costScores,
  experienceScore,
  num,
  scoreCarrier,
  type CarrierSignals,
} from "./scoring";

test("WEIGHTS sum exactly to 1.0 across all six carrier scoring dimensions", () => {
  const sum = Object.values(WEIGHTS).reduce((acc, w) => acc + w, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `Expected weights to sum to 1.0, got ${sum}`);
  assert.equal(WEIGHTS.cost, 0.3);
  assert.equal(WEIGHTS.onTime, 0.25);
  assert.equal(WEIGHTS.availability, 0.15);
  assert.equal(WEIGHTS.damage, 0.1);
  assert.equal(WEIGHTS.routeExperience, 0.1);
  assert.equal(WEIGHTS.service, 0.1);
});

test("experienceScore scales linearly up to 200 shipments and guards non-positive or invalid values", () => {
  assert.equal(experienceScore(null), 0);
  assert.equal(experienceScore(0), 0);
  assert.equal(experienceScore(-25), 0);
  assert.equal(experienceScore(Number.NaN), 0);
  assert.equal(experienceScore(Number.POSITIVE_INFINITY), 0);
  assert.equal(experienceScore(50), 0.25);
  assert.equal(experienceScore(100), 0.5);
  assert.equal(experienceScore(200), 1);
  assert.equal(experienceScore(1500), 1);
});

test("costScores normalizes cheapest quote to 1, dearest to 0, and handles ties/empty sets", () => {
  assert.deepEqual(costScores([]), []);
  assert.deepEqual(costScores([45000]), [1]);
  assert.deepEqual(costScores([12000, 12000, 12000]), [1, 1, 1]);

  const scores = costScores([100, 300, 500]);
  assert.equal(scores.length, 3);
  assert.equal(scores[0], 1);
  assert.equal(scores[1], 0.5);
  assert.equal(scores[2], 0);

  // Non-finite inputs fail safe rather than producing NaN
  assert.deepEqual(costScores([100, Number.NaN, 500]), [0, 0, 0]);
});

test("scoreCarrier computes full weighted score with damage inversion when cost quote is present", () => {
  const signals: CarrierSignals = {
    costScore: 1.0, // 0.30
    onTimeRate: 0.96, // 0.25 * 0.96 = 0.24
    availabilityRate: 0.9, // 0.15 * 0.90 = 0.135
    damageRate: 0.02, // inverted -> 0.98 * 0.10 = 0.098
    shipmentsCount: 200, // 1.0 * 0.10 = 0.10
    serviceScore: 0.85, // 0.10 * 0.85 = 0.085
  };

  const result = scoreCarrier(signals);
  assert.equal(result.costApplied, true);
  assert.ok(Math.abs(result.applied - 1.0) < 1e-9);
  assert.ok(Math.abs(result.total - 0.958) < 1e-9);
  assert.ok(Math.abs(result.normalised - 0.958) < 1e-9);
  assert.equal(result.parts.length, 6);

  const damagePart = result.parts.find((p) => p.label === "Damage");
  assert.ok(damagePart);
  assert.ok(Math.abs(damagePart.value - 0.98) < 1e-9);
});

test("scoreCarrier normalizes quality-only scores over applied weight (0.70) when cost quote is absent", () => {
  const result = scoreCarrier({
    onTimeRate: 0.9,
    availabilityRate: 0.8,
    damageRate: 0.1, // inverted -> 0.9
    shipmentsCount: 100, // experience -> 0.5
    serviceScore: 0.8,
  });

  assert.equal(result.costApplied, false);
  assert.ok(Math.abs(result.applied - 0.7) < 1e-9);
  const expectedTotal = 0.25 * 0.9 + 0.15 * 0.8 + 0.1 * 0.9 + 0.1 * 0.5 + 0.1 * 0.8;
  assert.ok(Math.abs(result.total - expectedTotal) < 1e-9);
  assert.ok(Math.abs(result.normalised - expectedTotal / 0.7) < 1e-9);
});

test("scoreCarrier clamps out-of-range metrics and ignores NaN/null inputs safely", () => {
  const result = scoreCarrier({
    costScore: Number.NaN,
    onTimeRate: 1.4, // clamped to 1
    availabilityRate: -0.2, // clamped to 0
    damageRate: 1.5, // clamped to 1 -> inverted 0
    shipmentsCount: null, // experience 0
    serviceScore: null,
  });

  assert.equal(result.costApplied, false);
  assert.ok(result.normalised >= 0 && result.normalised <= 1);
  assert.ok(Math.abs(result.applied - 0.6) < 1e-9); // onTime + availability + damage + routeExperience
  assert.ok(Math.abs(result.total - 0.25) < 1e-9); // only onTime contributes 0.25 * 1
});

test("num parses finite numbers and rejects blank, null, undefined, or non-numeric values", () => {
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(""), null);
  assert.equal(num("   "), null);
  assert.equal(num("not-a-number"), null);
  assert.equal(num(Number.NaN), null);
  assert.equal(num(Number.POSITIVE_INFINITY), null);
  assert.equal(num(0), 0);
  assert.equal(num("0"), 0);
  assert.equal(num("0.945"), 0.945);
  assert.equal(num(-12.5), -12.5);
});

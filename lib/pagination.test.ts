import test from "node:test";
import assert from "node:assert/strict";
import { signUp } from "@/lib/auth";
import { query, runWithOrgScope } from "@/lib/db";
import { listShipmentsPaginated } from "@/lib/queries";
import {
  buildPageHref,
  buildPaginatedResult,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parsePaginationParams,
} from "./pagination";

test("parsePaginationParams safely clamps invalid, negative, and oversized inputs", () => {
  assert.deepEqual(parsePaginationParams(undefined, undefined), {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    offset: 0,
  });
  assert.deepEqual(parsePaginationParams("-5", "0"), {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    offset: 0,
  });
  assert.deepEqual(parsePaginationParams("3", "5000"), {
    page: 3,
    pageSize: MAX_PAGE_SIZE,
    offset: 200,
  });
  assert.deepEqual(parsePaginationParams("2", "10"), {
    page: 2,
    pageSize: 10,
    offset: 10,
  });
});

test("buildPaginatedResult computes exact page metadata and handles empty sets", () => {
  const empty = buildPaginatedResult([], 0, 1, 25);
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.startIndex, 0);
  assert.equal(empty.endIndex, 0);
  assert.equal(empty.hasPrevious, false);
  assert.equal(empty.hasNext, false);

  const page2 = buildPaginatedResult(["a", "b", "c"], 23, 2, 10);
  assert.equal(page2.page, 2);
  assert.equal(page2.totalPages, 3);
  assert.equal(page2.startIndex, 11);
  assert.equal(page2.endIndex, 13);
  assert.equal(page2.hasPrevious, true);
  assert.equal(page2.hasNext, true);
});

test("buildPageHref preserves active query params and omits default page=1 / pageSize=25", () => {
  assert.equal(buildPageHref("/shipments", { page: 1, pageSize: 25 }), "/shipments");
  assert.equal(
    buildPageHref("/shipments", { state: "IN_TRANSIT", q: "Lagos", page: 2, pageSize: 10 }),
    "/shipments?state=IN_TRANSIT&q=Lagos&page=2&pageSize=10",
  );
  assert.equal(
    buildPageHref("/orders", { source: "API", q: "", page: 1, pageSize: 25 }),
    "/orders?source=API",
  );
});

test("listShipmentsPaginated slices records accurately per tenant with search and state filters", async () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const signup = await signUp({
    companyName: `Pagination Corp ${runId}`,
    name: "Ops Lead",
    email: `ops-page-${runId}@p1.test`,
    password: "StrongP1Password!2026",
  });
  assert.equal(signup.ok, true);
  if (!signup.ok) return;

  await runWithOrgScope(signup.user.orgId, async () => {
    for (let i = 1; i <= 15; i += 1) {
      await query(
        `INSERT INTO shipments (reference, state, customer_ref, origin, destination, cargo, created_via)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 'MANUAL')`,
        [
          `PG-${String(i).padStart(2, "0")}-${runId}`,
          i <= 10 ? "IN_TRANSIT" : "DELIVERED",
          i % 2 === 0 ? "Even Logistics" : "Odd Retail",
          JSON.stringify({ city: i <= 8 ? "Lagos" : "Nairobi" }),
          JSON.stringify({ city: "Accra" }),
          JSON.stringify({ quantity: i, weight_kg: i * 10 }),
        ],
      );
    }

    const p1 = await listShipmentsPaginated({ page: 1, pageSize: 10 });
    assert.equal(p1.total, 15);
    assert.equal(p1.items.length, 10);
    assert.equal(p1.totalPages, 2);
    assert.equal(p1.hasNext, true);
    assert.equal(p1.hasPrevious, false);

    const p2 = await listShipmentsPaginated({ page: 2, pageSize: 10 });
    assert.equal(p2.total, 15);
    assert.equal(p2.items.length, 5);
    assert.equal(p2.hasNext, false);
    assert.equal(p2.hasPrevious, true);

    const deliveredOnly = await listShipmentsPaginated({ state: "DELIVERED", page: 1, pageSize: 10 });
    assert.equal(deliveredOnly.total, 5);
    assert.equal(deliveredOnly.items.length, 5);

    const searchNairobi = await listShipmentsPaginated({ q: "Nairobi", page: 1, pageSize: 10 });
    assert.equal(searchNairobi.total, 7);
    assert.equal(searchNairobi.items.length, 7);
  });
});

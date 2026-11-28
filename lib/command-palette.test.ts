import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_ITEMS,
  filterCommandItems,
  isShipmentReference,
  resolveCommandTarget,
} from "./command-palette";

describe("command-palette pure helpers", () => {
  it("indexes all 24 Control Tower routes with unique ids and hrefs", () => {
    assert.equal(COMMAND_ITEMS.length, 24);
    const ids = new Set(COMMAND_ITEMS.map((i) => i.id));
    const hrefs = new Set(COMMAND_ITEMS.map((i) => i.href));
    assert.equal(ids.size, 24);
    assert.equal(hrefs.size, 24);
  });

  it("prioritizes exact and prefix label matches over description matches", () => {
    const results = filterCommandItems("ware");
    assert.ok(results.length >= 1);
    assert.equal(results[0].href, "/warehouses");

    const approvalResults = filterCommandItems("approv");
    assert.equal(approvalResults[0].href, "/approvals");
  });

  it("matches by operational keywords such as customs, rma, or rbac", () => {
    assert.equal(filterCommandItems("rma")[0]?.href, "/returns");
    assert.equal(filterCommandItems("rbac")[0]?.href, "/settings");
    assert.ok(filterCommandItems("customs").some((i) => i.href === "/orders"));
  });

  it("detects valid shipment references cleanly", () => {
    assert.equal(isShipmentReference("SHP-1042"), true);
    assert.equal(isShipmentReference("ct_9901"), true);
    assert.equal(isShipmentReference("ORD12345"), true);
    assert.equal(isShipmentReference("warehouses"), false);
    assert.equal(isShipmentReference("a1"), false);
  });

  it("resolves selected item, shipment reference, or fallback search URL", () => {
    const warehouses = COMMAND_ITEMS.find((i) => i.href === "/warehouses")!;
    assert.equal(resolveCommandTarget("ware", warehouses), "/warehouses");
    assert.equal(resolveCommandTarget("shp-2048", null), "/shipments/SHP-2048");
    assert.equal(
      resolveCommandTarget("Lagos corridor", null),
      "/shipments?q=Lagos%20corridor",
    );
    assert.equal(resolveCommandTarget("   ", null), null);
  });
});

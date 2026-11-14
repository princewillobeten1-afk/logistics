-- 013_reservations.sql — make allocation actually reserve.
--
-- `warehouse.allocate` has been emitting `warehouse.allocation_reserved` while
-- reserving nothing: `inventory_reservations` had zero rows and no code path
-- wrote to it. Two shipments could be allocated the same stock and both would
-- believe they had it.
--
-- The index below is what makes reserving idempotent. A handler can be retried
-- — the worker retries on any failure, and the orchestrator retries when
-- applying a result fails — so reserving must be safe to run twice. One HELD
-- reservation per (shipment, warehouse, sku) means a retry collides instead of
-- double-counting the stock.

CREATE UNIQUE INDEX IF NOT EXISTS inventory_reservations_one_held_idx
    ON inventory_reservations (shipment_id, warehouse_id, sku)
    WHERE state = 'HELD';

ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_state_known;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_state_known
    CHECK (state IN ('HELD', 'CONSUMED', 'RELEASED', 'EXPIRED'));

-- Releasing a shipment's holds is a per-shipment operation; give it an index
-- rather than a scan of every reservation ever made.
CREATE INDEX IF NOT EXISTS inventory_reservations_held_idx
    ON inventory_reservations (shipment_id) WHERE state = 'HELD';

INSERT INTO schema_migrations (version) VALUES ('013_reservations')
    ON CONFLICT (version) DO NOTHING;

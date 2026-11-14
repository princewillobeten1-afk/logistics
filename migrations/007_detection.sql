-- 007_detection.sql — guards for the detection engine.
--
-- Detection runs on every tracking event. At a 15-minute poll a single delayed
-- truck would otherwise raise the same ETA_DRIFT exception ~96 times a day,
-- burying the operator and — once the Exception Agent is wired up — burning a
-- model call on each one. One open exception per kind per shipment.

CREATE UNIQUE INDEX IF NOT EXISTS exceptions_one_open_per_kind_idx
    ON exceptions (shipment_id, kind)
    WHERE state NOT IN ('RESOLVED', 'ABANDONED');

-- The sweep's query: active shipments whose last tracking event is old, or
-- which have never reported at all.
CREATE INDEX IF NOT EXISTS shipments_trackable_idx
    ON shipments (state)
    WHERE state IN ('BOOKED', 'IN_TRANSIT');

-- Detections carry a machine-readable severity and a human summary; the
-- summary is what the dashboard shows and what an agent is later handed.
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS summary TEXT;

-- Keep tracking partitions running ahead of ingest. An insert into a missing
-- partition is an error, so this is called on every ingest batch as well as
-- from the sweep — it is a no-op once the partition exists.
CREATE OR REPLACE FUNCTION ensure_tracking_partitions(months_ahead INTEGER DEFAULT 3)
RETURNS INTEGER AS $$
DECLARE
    created INTEGER := 0;
    n INTEGER;
BEGIN
    FOR n IN 0..months_ahead LOOP
        PERFORM ensure_tracking_partition(
            (CURRENT_DATE + (n || ' month')::interval)::date
        );
        created := created + 1;
    END LOOP;
    RETURN created;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version) VALUES ('007_detection')
    ON CONFLICT (version) DO NOTHING;

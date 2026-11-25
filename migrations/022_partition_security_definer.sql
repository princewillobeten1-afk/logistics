-- 022_partition_security_definer.sql — allow logistics_app to ensure monthly
-- tracking_events partitions without granting schema-wide CREATE rights.
--
-- Migration 017 introduced the unprivileged `logistics_app` role so RLS is
-- always enforced. That role has DML only, so calling `ensure_tracking_partitions`
-- from `detection.sweep` or `tracking.ingest` failed with
-- `InsufficientPrivilege: permission denied for schema public` as soon as a
-- new month partition was needed.
--
-- Making `ensure_tracking_partition` SECURITY DEFINER (with an explicit
-- search_path) runs only the fixed `CREATE TABLE tracking_events_YYYY_MM
-- PARTITION OF tracking_events` DDL under the owner role, while preserving
-- full RLS enforcement on every query.

CREATE OR REPLACE FUNCTION ensure_tracking_partition(target DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    start_at DATE := date_trunc('month', target)::date;
    end_at   DATE := (date_trunc('month', target) + interval '1 month')::date;
    part     TEXT := 'tracking_events_' || to_char(start_at, 'YYYY_MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF tracking_events FOR VALUES FROM (%L) TO (%L)',
            part, start_at, end_at
        );
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
            EXECUTE format(
                'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO logistics_app',
                part
            );
        END IF;
    END IF;
    RETURN part;
END;
$$;

SELECT ensure_tracking_partitions(3);

-- Backfill a conservative default policy for any active organisation created
-- before `seedNewOrgDefaults` / `create-org` seeded policies automatically.
INSERT INTO policies (org_id, version, name, rules, active)
SELECT o.id,
       1,
       'default conservative',
       '{
         "base_currency": "NGN",
         "fx_max_age_hours": 24,
         "auto_execute_tiers": [0, 1],
         "actions": {
           "book_shipment": {
             "auto_approve_below_minor": 0,
             "hard_deny_above_minor": 200000000,
             "note": "Phase 1: every booking goes to a human. Raise in phase 6."
           },
           "reroute_vehicle": {
             "auto_approve_below_minor": 0,
             "hard_deny_above_minor": 50000000,
             "max_cost_increase_pct": 5
           },
           "create_invoice": { "auto_approve_below_minor": null },
           "send_whatsapp": { "auto_approve_below_minor": null },
           "send_email": { "auto_approve_below_minor": null },
           "cancel_shipment": { "auto_approve_below_minor": null },
           "change_delivery_address": { "auto_approve_below_minor": null },
           "settle_claim": {
             "auto_approve_below_minor": 0,
             "hard_deny_above_minor": 100000000
           }
         },
         "require_approval_when": {
           "unapproved_carrier": true,
           "address_change": true,
           "hazmat": true,
           "temperature_controlled": false,
           "customs_uncertain": true,
           "cancellation": true,
           "sla_breach_risk": true,
           "declared_value_above_minor": 500000000
         },
         "default_decision": "REQUIRE_APPROVAL"
       }'::jsonb,
       true
  FROM organisations o
 WHERE o.active
   AND NOT EXISTS (
       SELECT 1 FROM policies p WHERE p.org_id = o.id AND p.active
   )
ON CONFLICT (org_id, version) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('022_partition_security_definer')
    ON CONFLICT (version) DO NOTHING;

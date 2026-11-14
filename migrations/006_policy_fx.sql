-- 006_policy_fx.sql — policy version 2: multi-currency and non-monetary gates.
--
-- Version 1 compared amount_minor directly against a threshold. With a second
-- currency in the system that is dangerous: a USD amount against an NGN cap
-- would auto-approve something ~1,500x over budget. Version 2 adds a base
-- currency and a maximum FX age, and the engine now normalises before
-- comparing and denies when it cannot.
--
-- Also adds the non-monetary approval triggers, which need no schema change —
-- they are rules data.

-- Deactivate every prior version, not just v1. `policies_single_active_idx`
-- allows exactly one active row, so anything left active blocks the insert.
UPDATE policies SET active = false WHERE active;

INSERT INTO policies (version, name, rules, active)
VALUES (
    2,
    'phase-1 conservative, multi-currency',
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
        "create_invoice":  { "auto_approve_below_minor": null },
        "send_whatsapp":   { "auto_approve_below_minor": null },
        "send_email":      { "auto_approve_below_minor": null },
        "cancel_shipment": { "auto_approve_below_minor": null },
        "change_delivery_address": { "auto_approve_below_minor": null },
        "settle_claim": {
          "auto_approve_below_minor": 0,
          "hard_deny_above_minor": 100000000
        }
      },
      "require_approval_when": {
        "unapproved_carrier":     true,
        "address_change":         true,
        "hazmat":                 true,
        "temperature_controlled": false,
        "customs_uncertain":      true,
        "cancellation":           true,
        "sla_breach_risk":        true,
        "declared_value_above_minor": 500000000
      },
      "default_decision": "REQUIRE_APPROVAL"
    }'::jsonb,
    true
)
ON CONFLICT (version) DO UPDATE
    SET rules = EXCLUDED.rules, active = true;

-- A seed rate so a fresh dev database can evaluate a non-NGN amount at all.
-- Illustrative only; production rates come from a feed.
INSERT INTO fx_rates (base, quote, rate, as_of, source) VALUES
    ('USD', 'NGN', 1580.00000000, now(), 'seed'),
    ('EUR', 'NGN', 1710.00000000, now(), 'seed'),
    ('GBP', 'NGN', 1995.00000000, now(), 'seed')
ON CONFLICT (base, quote, as_of) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('006_policy_fx')
    ON CONFLICT (version) DO NOTHING;

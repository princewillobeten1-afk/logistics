-- 002_seed_policy.sql — the initial spend policy.
--
-- Money is integer minor units (kobo). ₦500,000 = 50,000,000 kobo.
--
-- Deliberately conservative for phase 1: nothing that spends money executes
-- without a human. The caps below are the shape the rules take, not the
-- autonomy level — phase 6 raises them against measured agreement rates, and
-- raising them is an UPDATE here, not a deploy.

INSERT INTO policies (version, name, rules, active)
VALUES (
    1,
    'phase-1 conservative',
    '{
      "currency": "NGN",
      "auto_execute_tiers": [0, 1],
      "actions": {
        "book_shipment": {
          "auto_approve_below_minor": 0,
          "hard_deny_above_minor": 200000000,
          "note": "Phase 1: every booking goes to a human. Raise the cap in phase 6."
        },
        "reroute_vehicle": {
          "auto_approve_below_minor": 0,
          "hard_deny_above_minor": 50000000
        },
        "create_invoice": {
          "auto_approve_below_minor": null,
          "note": "Never automatic."
        },
        "send_whatsapp": {
          "auto_approve_below_minor": null,
          "note": "Tier 2. Irreversible socially — a wrong message cannot be unsent."
        },
        "send_email": {
          "auto_approve_below_minor": null
        }
      },
      "default_decision": "REQUIRE_APPROVAL"
    }'::jsonb,
    true
)
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('002_seed_policy')
    ON CONFLICT (version) DO NOTHING;

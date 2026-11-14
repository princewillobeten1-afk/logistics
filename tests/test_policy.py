from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from logistics.orchestrator.policy import Decision

NAIRA = 100  # kobo
CAP = 500_000 * NAIRA


async def _set_rules(db, rules: dict) -> None:
    rules.setdefault("base_currency", "NGN")
    rules.setdefault("fx_max_age_hours", 24)
    async with db.connection() as conn:
        await conn.execute("UPDATE policies SET active = false WHERE active")
        await conn.execute(
            "INSERT INTO policies (version, name, rules, active)"
            " VALUES (99, 'test', %s, true)"
            " ON CONFLICT (org_id, version) DO UPDATE"
            "   SET rules = EXCLUDED.rules, active = true",
            (json.dumps(rules),),
        )


async def _rate(db, base: str, quote: str, rate: str, age_hours: float = 0) -> None:
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_rates (base, quote, rate, as_of, source)"
            " VALUES (%s, %s, %s, %s, 'test')"
            " ON CONFLICT (base, quote, as_of) DO NOTHING",
            (base, quote, Decimal(rate), datetime.now(UTC) - timedelta(hours=age_hours)),
        )


def _booking(**rule):  # noqa: ANN201
    return {"actions": {"book_shipment": {"auto_approve_below_minor": CAP, **rule}}}


def _ngn(amount: int) -> dict:
    return {"amount_minor": amount, "currency": "NGN"}


# ------------------------------------------------------------- fail closed


async def test_no_active_policy_denies(db, policy):
    async with db.connection() as conn:
        await conn.execute("UPDATE policies SET active = false")
    result = await policy.evaluate("book_shipment", _ngn(1), tier=3)
    assert result.decision is Decision.DENY
    assert "no active policy" in result.reason


async def test_float_amount_is_refused(db, policy):
    await _set_rules(db, _booking())
    result = await policy.evaluate(
        "book_shipment", {"amount_minor": 47500000.5, "currency": "NGN"}, tier=3
    )
    assert result.decision is Decision.DENY


async def test_amount_without_a_currency_is_refused(db, policy):
    """An unlabelled amount cannot be compared to anything safely."""
    await _set_rules(db, _booking())
    result = await policy.evaluate("book_shipment", {"amount_minor": 1}, tier=3)
    assert result.decision is Decision.DENY
    assert "currency" in result.reason


# ------------------------------------------------------------ spend caps


async def test_below_cap_auto_approves(db, policy):
    await _set_rules(db, _booking())
    result = await policy.evaluate("book_shipment", _ngn(475_000 * NAIRA), tier=3)
    assert result.decision is Decision.ALLOW


async def test_at_or_above_cap_requires_approval(db, policy):
    """The §8 case: ₦650,000 against a ₦500,000 cap."""
    await _set_rules(db, _booking())
    result = await policy.evaluate("book_shipment", _ngn(650_000 * NAIRA), tier=3)
    assert result.decision is Decision.REQUIRE_APPROVAL


async def test_hard_ceiling_denies_outright(db, policy):
    await _set_rules(db, _booking(hard_deny_above_minor=2_000_000 * NAIRA))
    result = await policy.evaluate("book_shipment", _ngn(5_000_000 * NAIRA), tier=3)
    assert result.decision is Decision.DENY


async def test_missing_amount_never_auto_approves(db, policy):
    await _set_rules(db, _booking())
    result = await policy.evaluate("book_shipment", {}, tier=3)
    assert result.decision is Decision.REQUIRE_APPROVAL
    assert "amount_minor" in result.reason


async def test_null_cap_means_never_automatic(db, policy):
    await _set_rules(db, {"actions": {"create_invoice": {"auto_approve_below_minor": None}}})
    result = await policy.evaluate("create_invoice", _ngn(1), tier=3)
    assert result.decision is Decision.REQUIRE_APPROVAL


async def test_unknown_action_requires_approval(db, policy):
    await _set_rules(db, {"actions": {}, "auto_execute_tiers": [0, 1]})
    assert (await policy.evaluate("something_new", {}, tier=3)).decision is Decision.REQUIRE_APPROVAL


async def test_read_only_tiers_pass_without_a_rule(db, policy):
    await _set_rules(db, {"actions": {}, "auto_execute_tiers": [0, 1]})
    assert (await policy.evaluate("check_inventory", {}, tier=0)).decision is Decision.ALLOW


async def test_a_priced_action_is_never_waved_through_on_tier_alone(db, policy):
    """Tier 0 with an amount attached still gets checked."""
    await _set_rules(db, {"actions": {}, "auto_execute_tiers": [0, 1]})
    result = await policy.evaluate("odd_action", _ngn(9_999_999), tier=0)
    assert result.decision is Decision.REQUIRE_APPROVAL


# --------------------------------------------------------- multi-currency


async def test_foreign_amount_is_converted_before_comparison(db, policy):
    """Without conversion, $1,000 (100000 minor) reads as under a ₦500,000 cap
    and auto-approves something ~1,580,000 naira."""
    await _set_rules(db, _booking())
    await _rate(db, "USD", "NGN", "1580")

    result = await policy.evaluate(
        "book_shipment", {"amount_minor": 100_000, "currency": "USD"}, tier=3
    )
    assert result.decision is Decision.REQUIRE_APPROVAL, (
        "USD 1,000 = NGN 1,580,000, which is over the NGN 500,000 cap"
    )
    assert "NGN" in result.reason


async def test_small_foreign_amount_still_auto_approves(db, policy):
    await _set_rules(db, _booking())
    await _rate(db, "USD", "NGN", "1580")
    result = await policy.evaluate(
        "book_shipment", {"amount_minor": 10_000, "currency": "USD"}, tier=3
    )
    assert result.decision is Decision.ALLOW  # $100 = ₦158,000


async def test_missing_fx_rate_denies(db, policy):
    await _set_rules(db, _booking())
    result = await policy.evaluate(
        "book_shipment", {"amount_minor": 1000, "currency": "ZAR"}, tier=3
    )
    assert result.decision is Decision.DENY
    assert "cannot verify spend" in result.reason


async def test_stale_fx_rate_denies(db, policy):
    await _set_rules(db, {**_booking(), "fx_max_age_hours": 6})
    await _rate(db, "CNY", "NGN", "220", age_hours=48)
    result = await policy.evaluate(
        "book_shipment", {"amount_minor": 1000, "currency": "CNY"}, tier=3
    )
    assert result.decision is Decision.DENY
    assert "cannot verify spend" in result.reason


async def test_hard_ceiling_applies_after_conversion(db, policy):
    await _set_rules(db, _booking(hard_deny_above_minor=2_000_000 * NAIRA))
    await _rate(db, "USD", "NGN", "1580")
    result = await policy.evaluate(
        "book_shipment", {"amount_minor": 500_000, "currency": "USD"}, tier=3
    )
    assert result.decision is Decision.DENY  # $5,000 = ₦7.9m


# ------------------------------------------------------ non-monetary gates


async def test_unapproved_carrier_requires_approval_regardless_of_amount(db, policy):
    await _set_rules(db, {**_booking(), "require_approval_when": {"unapproved_carrier": True}})
    result = await policy.evaluate(
        "book_shipment", {**_ngn(1000), "carrier_approved": False}, tier=3
    )
    assert result.decision is Decision.REQUIRE_APPROVAL
    assert "approved list" in result.reason


async def test_approved_carrier_under_cap_still_auto_approves(db, policy):
    await _set_rules(db, {**_booking(), "require_approval_when": {"unapproved_carrier": True}})
    result = await policy.evaluate(
        "book_shipment", {**_ngn(1000), "carrier_approved": True}, tier=3
    )
    assert result.decision is Decision.ALLOW


async def test_hazmat_requires_approval(db, policy):
    await _set_rules(db, {**_booking(), "require_approval_when": {"hazmat": True}})
    result = await policy.evaluate("book_shipment", {**_ngn(1000), "hazmat": True}, tier=3)
    assert result.decision is Decision.REQUIRE_APPROVAL


async def test_address_change_requires_approval_with_no_amount(db, policy):
    """The dangerous ones often carry no price at all."""
    await _set_rules(db, {
        "actions": {},
        "auto_execute_tiers": [0, 1],
        "require_approval_when": {"address_change": True},
    })
    result = await policy.evaluate(
        "change_delivery_address", {"address_changed": True}, tier=1
    )
    assert result.decision is Decision.REQUIRE_APPROVAL


async def test_high_declared_value_requires_approval(db, policy):
    await _set_rules(db, {
        **_booking(),
        "require_approval_when": {"declared_value_above_minor": 500_000 * NAIRA},
    })
    result = await policy.evaluate(
        "book_shipment", {**_ngn(1000), "declared_value_minor": 900_000 * NAIRA}, tier=3
    )
    assert result.decision is Decision.REQUIRE_APPROVAL
    assert "declared value" in result.reason


async def test_disabled_trigger_does_not_fire(db, policy):
    await _set_rules(db, {**_booking(), "require_approval_when": {"hazmat": False}})
    result = await policy.evaluate("book_shipment", {**_ngn(1000), "hazmat": True}, tier=3)
    assert result.decision is Decision.ALLOW


# ------------------------------------------------------------- shipped policy


async def test_shipped_policy_blocks_every_booking(db, policy):
    """Phase 1 ships conservative: nothing that spends money is automatic."""
    result = await policy.evaluate("book_shipment", _ngn(1), tier=3)
    assert result.decision is Decision.REQUIRE_APPROVAL


async def test_shipped_policy_gates_cancellation(db, policy):
    result = await policy.evaluate("cancel_shipment", {"cancelling": True}, tier=3)
    assert result.decision is Decision.REQUIRE_APPROVAL


# ------------------------------------------------------------------ propose


async def test_propose_records_the_gate_decision(db, policy, repo, reference):
    shipment = await repo.create(reference=reference)
    proposal = await policy.propose(
        shipment_id=shipment.id,
        action="book_shipment",
        params={**_ngn(650_000 * NAIRA), "carrier": "C"},
        tier=3,
        rationale="Only carrier able to meet the SLA.",
    )
    assert proposal.result.decision is Decision.REQUIRE_APPROVAL

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT action, state, policy_decision, rationale, tier"
            "  FROM proposed_actions WHERE id = %s",
            (proposal.id,),
        )
        row = await cur.fetchone()

    assert row["state"] == "PROPOSED", "proposing must never execute"
    assert row["policy_decision"] == "REQUIRE_APPROVAL"
    assert row["tier"] == 3
    assert "SLA" in row["rationale"]

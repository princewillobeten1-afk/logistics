"""The policy gate.

Deliberately outside the model's reach. An agent proposes an action; this
decides whether it may happen. "The model was instructed not to spend more than
₦500,000" is not a spend control — this is.

Two properties matter more than the rule content:

  * It fails closed. No active policy, an unknown action, or a missing amount
    all resolve to DENY or REQUIRE_APPROVAL, never ALLOW.
  * Money is integer minor units (kobo). Never floats.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from logistics.db import Database
from logistics.domain.money import (
    CurrencyConverter,
    MissingRate,
    Money,
    StaleRate,
)
from logistics.obs import get_logger

log = get_logger(__name__)


class Decision(StrEnum):
    ALLOW = "ALLOW"
    REQUIRE_APPROVAL = "REQUIRE_APPROVAL"
    DENY = "DENY"


@dataclass(frozen=True, slots=True)
class PolicyResult:
    decision: Decision
    reason: str
    version: int | None = None

    @property
    def may_execute(self) -> bool:
        return self.decision is Decision.ALLOW


@dataclass(frozen=True, slots=True)
class Proposal:
    id: UUID
    action: str
    result: PolicyResult


class PolicyEngine:
    def __init__(self, db: Database, converter: CurrencyConverter | None = None) -> None:
        self._db = db
        self._converter = converter or CurrencyConverter(db)

    async def active(self) -> tuple[int, dict[str, Any]] | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT version, rules FROM policies WHERE active ORDER BY version DESC LIMIT 1"
            )
            row = await cur.fetchone()
        return (row["version"], row["rules"]) if row else None

    async def evaluate(
        self, action: str, params: dict[str, Any], *, tier: int
    ) -> PolicyResult:
        loaded = await self.active()
        if loaded is None:
            # Fail closed. A system with no policy must not spend money.
            log.error("policy.missing", action=action)
            return PolicyResult(Decision.DENY, "no active policy is configured")

        version, rules = loaded
        base_currency = rules.get("base_currency", "NGN")

        raw_amount = params.get("amount_minor")
        if isinstance(raw_amount, float):
            return PolicyResult(
                Decision.DENY, "amount_minor must be integer minor units, not a float", version
            )

        # Non-monetary triggers come first: they apply regardless of amount, and
        # some of the most dangerous actions carry no price at all.
        if (trigger := self._non_monetary_trigger(rules, params)) is not None:
            return PolicyResult(Decision.REQUIRE_APPROVAL, trigger, version)

        rule = (rules.get("actions") or {}).get(action)
        if rule is None:
            auto_tiers = set(rules.get("auto_execute_tiers") or [])
            if tier in auto_tiers and raw_amount is None:
                return PolicyResult(
                    Decision.ALLOW, f"tier {tier} is auto-executable and carries no spend", version
                )
            return PolicyResult(
                Decision.REQUIRE_APPROVAL, f"no rule for action {action!r}", version
            )

        # Normalise to the policy's base currency BEFORE any comparison. A USD
        # amount against an NGN cap would otherwise auto-approve something
        # roughly 1,500x over budget.
        try:
            amount = await self._normalised(params, base_currency, rules)
        except (MissingRate, StaleRate) as exc:
            log.error("policy.fx_unavailable", action=action, error=str(exc))
            return PolicyResult(
                Decision.DENY, f"cannot verify spend: {exc}", version
            )
        except ValueError as exc:
            return PolicyResult(Decision.DENY, str(exc), version)

        hard_deny = rule.get("hard_deny_above_minor")
        if hard_deny is not None and amount is not None:
            if amount > Money(hard_deny, base_currency):
                return PolicyResult(
                    Decision.DENY,
                    f"{amount.format()} exceeds the hard ceiling of "
                    f"{Money(hard_deny, base_currency).format()} for {action}",
                    version,
                )

        threshold = rule.get("auto_approve_below_minor")
        if threshold is None:
            return PolicyResult(
                Decision.REQUIRE_APPROVAL, f"{action} always requires approval", version
            )

        if amount is None:
            # An unpriced spend request is exactly when not to auto-approve.
            return PolicyResult(
                Decision.REQUIRE_APPROVAL,
                f"{action} carries no amount_minor, so spend cannot be checked",
                version,
            )

        cap = Money(threshold, base_currency)
        if amount < cap:
            return PolicyResult(
                Decision.ALLOW,
                f"{amount.format()} is below the {cap.format()} auto-approve cap",
                version,
            )
        return PolicyResult(
            Decision.REQUIRE_APPROVAL,
            f"{amount.format()} is at or above the {cap.format()} auto-approve cap",
            version,
        )

    async def _normalised(
        self, params: dict[str, Any], base_currency: str, rules: dict[str, Any]
    ) -> Money | None:
        """The action's amount, in the policy's base currency."""
        money = Money.from_params(params)
        if money is None:
            return None
        return await self._converter.convert(
            money,
            base_currency,
            max_age_hours=rules.get("fx_max_age_hours"),
        )

    @staticmethod
    def _non_monetary_trigger(rules: dict[str, Any], params: dict[str, Any]) -> str | None:
        """Approval triggers that have nothing to do with cost.

        Booking an unvetted carrier or redirecting a delivery can do more damage
        than an expensive but ordinary booking.
        """
        triggers = rules.get("require_approval_when") or {}
        checks = (
            ("unapproved_carrier", "carrier_approved", False,
             "the selected carrier is not on the approved list"),
            ("address_change", "address_changed", True,
             "the delivery address is being changed"),
            ("hazmat", "hazmat", True, "the cargo is hazardous"),
            ("temperature_controlled", "temperature_controlled", True,
             "the cargo is temperature-controlled"),
            ("customs_uncertain", "customs_uncertain", True,
             "customs classification is uncertain"),
            ("cancellation", "cancelling", True, "the shipment is being cancelled"),
            ("sla_breach_risk", "sla_breach_risk", True,
             "the contracted SLA is at risk of being breached"),
        )
        for rule_key, param_key, trips_on, reason in checks:
            if triggers.get(rule_key) and params.get(param_key) is trips_on:
                return reason

        ceiling = triggers.get("declared_value_above_minor")
        declared = params.get("declared_value_minor")
        if ceiling is not None and isinstance(declared, int) and declared > ceiling:
            return f"declared value {declared} exceeds the {ceiling} high-value threshold"
        return None

    async def propose(
        self,
        *,
        shipment_id: UUID,
        action: str,
        params: dict[str, Any],
        tier: int,
        rationale: str | None = None,
        agent_run_id: UUID | None = None,
        work_item_id: UUID | None = None,
    ) -> Proposal:
        """Record what an agent wants and what policy decided about it.

        The row is the audit record of the gate. Nothing here executes anything.
        """
        result = await self.evaluate(action, params, tier=tier)
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO proposed_actions
                    (shipment_id, agent_run_id, work_item_id, action, params, rationale,
                     tier, policy_decision, policy_reason, policy_version, state, decided_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'PROPOSED', now())
                RETURNING id
                """,
                (
                    shipment_id,
                    agent_run_id,
                    work_item_id,
                    action,
                    Jsonb(params),
                    rationale,
                    tier,
                    str(result.decision),
                    result.reason,
                    result.version,
                ),
            )
            row = await cur.fetchone()
            assert row is not None

        log.info(
            "policy.decided",
            action=action,
            decision=str(result.decision),
            reason=result.reason,
            shipment_id=str(shipment_id),
        )
        return Proposal(id=row["id"], action=action, result=result)

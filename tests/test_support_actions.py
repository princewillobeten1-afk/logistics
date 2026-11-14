"""The delegated actions, against a real database.

These are the tests that matter now the support agent can cause work: what a
chat message is allowed to do, and what it must not.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from pydantic import SecretStr

from logistics.channels.base import ChannelKind, Inbound
from logistics.channels.inbound import InboundRouter
from logistics.domain.models import WorkItem
from logistics.domain.states import ShipmentState
from logistics.handlers.base import PermanentFailure, StepContext
from logistics.handlers.support_actions import (
    MAX_SHIPMENTS_PER_HOUR,
    change_request,
    create_shipment,
    escalate,
)
from logistics.support.decide import OrderDraft
from logistics.support.wpcargo import (
    WPCargoSubmission,
    build_wpcargo_payload,
    parse_wpcargo_form,
)

S = ShipmentState

ORDER = {
    "shipper_name": "Chidi Okonkwo",
    "shipper_phone": "08023334444",
    "shipper_email": "chidi@example.com",
    "pickup": "Plot 14 Acme Way, Ikeja, Lagos",
    "receiver_name": "Musa Danjuma",
    "receiver_phone": "08031112222",
    "receiver_email": "musa@example.com",
    "destination": "12 Ahmadu Bello Way, Garki, Abuja",
    "description": "cartons of soap",
    "quantity": 50,
    "weight_kg": 900,
    "deadline": None,
}


def _ctx(db, settings, payload, *, shipment=None, policy=None, kind="support.create_shipment"):  # noqa: ANN001
    return StepContext(
        item=WorkItem(
            id=uuid4(), kind=kind, payload=payload, attempts=1, max_attempts=5,
            shipment_id=shipment.id if shipment else None,
        ),
        shipment=shipment,
        db=db,
        settings=settings,
        policy=policy,
    )


async def _contact(db, external_id="777") -> UUID:
    routed = await InboundRouter(db).route(
        Inbound(channel=ChannelKind.TELEGRAM, external_id=external_id, text="hello")
    )
    return routed.contact_id


async def _message(db, contact_id) -> UUID:  # noqa: ANN001
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM communications WHERE contact_id = %s LIMIT 1", (contact_id,)
        )
        return (await cur.fetchone())["id"]


# --------------------------------------------------------- order creation


async def test_a_chat_booking_creates_a_shipment(db, settings, queue):
    contact = await _contact(db)
    payload = {
        "contact_id": str(contact),
        "communication_id": str(await _message(db, contact)),
        "order": ORDER,
    }
    await create_shipment(_ctx(db, settings, payload))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT reference, state, created_via, origin_contact_id, origin, destination, cargo"
            "  FROM shipments WHERE created_via = 'CHAT'"
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["state"] == "DRAFT"
    assert row["reference"].startswith("CX-")
    assert row["origin_contact_id"] == contact
    assert row["cargo"]["quantity"] == 50
    assert row["origin"]["contact_name"] == "Chidi Okonkwo"
    assert row["destination"]["contact_name"] == "Musa Danjuma"


async def test_the_shipment_is_handed_to_the_pipeline(db, settings, queue):
    """The delegation the whole design turns on: support hands to the
    orchestrator, which routes to order.validate."""
    contact = await _contact(db)
    await create_shipment(
        _ctx(db, settings, {
            "contact_id": str(contact),
            "communication_id": str(await _message(db, contact)),
            "order": ORDER,
        })
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT kind FROM work_items WHERE kind = 'order.validate'"
        )
        assert await cur.fetchone() is not None


async def test_wpcargo_registration_syncs_reference_and_hands_to_orchestrator(
    db, settings, queue, monkeypatch
):
    """When WPCargo is configured, support.create_shipment registers the
    customer's shipment on the WordPress WPCargo portal first, syncs the
    WPCargo tracking number onto shipments.reference, records the
    wpcargo.registered audit event, and starts the Orchestrator pipeline."""
    import logistics.handlers.support_actions as sa

    captured_orders: list[dict] = []

    async def fake_submit_wpcargo(cfg, order, *, fallback_reference=None):  # noqa: ANN001, ARG001
        captured_orders.append(order)
        return WPCargoSubmission(
            post_id="1921",
            reference="0576420",
            edit_url="https://test.swiftparcelcourier.com/wp-admin/post.php?post=1921&action=edit",
        )

    monkeypatch.setattr(sa, "submit_wpcargo_shipment", fake_submit_wpcargo)

    wp_settings = settings.model_copy(
        update={
            "wpcargo_url": "https://test.swiftparcelcourier.com",
            "wpcargo_username": "admin",
            "wpcargo_password": SecretStr("secret"),
        }
    )
    contact = await _contact(db)
    await create_shipment(
        _ctx(db, wp_settings, {
            "contact_id": str(contact),
            "communication_id": str(await _message(db, contact)),
            "order": ORDER,
        })
    )

    assert len(captured_orders) == 1
    assert captured_orders[0]["shipper_name"] == "Chidi Okonkwo"
    assert captured_orders[0]["receiver_name"] == "Musa Danjuma"

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, reference, origin, destination FROM shipments WHERE created_via = 'CHAT'"
        )
        shipment = await cur.fetchone()
        assert shipment["reference"] == "0576420"
        assert shipment["origin"]["contact_name"] == "Chidi Okonkwo"

        cur = await conn.execute(
            "SELECT type, payload FROM shipment_events WHERE shipment_id = %s AND type = 'wpcargo.registered'",
            (shipment["id"],),
        )
        ev = await cur.fetchone()
        assert ev is not None
        assert ev["payload"]["reference"] == "0576420"
        assert ev["payload"]["post_id"] == "1921"

        cur = await conn.execute(
            "SELECT kind FROM work_items WHERE shipment_id = %s AND kind = 'order.validate'",
            (shipment["id"],),
        )
        assert await cur.fetchone() is not None


def test_wpcargo_form_parsing_and_payload_mapping():
    html = """
    <form name="post" action="post.php" method="post" id="post">
      <input type="hidden" id="_wpnonce" name="_wpnonce" value="abc123nonce" />
      <input type="hidden" name="user_ID" value="1" />
      <input type="hidden" id="post_ID" name="post_ID" value="1921" />
      <input type="hidden" id="wpc_metabox_nonce" name="wpc_metabox_nonce" value="meta456" />
      <input type="hidden" id="wpc_mp_inner_custom_box_nonce" name="wpc_mp_inner_custom_box_nonce" value="mp789" />
      <script>
        jQuery(document).ready(function($) {
            $( "#titlewrap #title" ).val('0576420');
        });
      </script>
    </form>
    """
    form_defaults, generated_ref = parse_wpcargo_form(html)
    assert generated_ref == "0576420"
    assert form_defaults["post_ID"] == "1921"
    assert form_defaults["_wpnonce"] == "abc123nonce"
    assert form_defaults["wpc_metabox_nonce"] == "meta456"
    assert form_defaults["wpc_mp_inner_custom_box_nonce"] == "mp789"

    payload = build_wpcargo_payload(form_defaults, ORDER, reference="0576420")
    assert payload["post_title"] == "0576420"
    assert payload["wpcargo_shipper_name"] == "Chidi Okonkwo"
    assert payload["wpcargo_shipper_phone"] == "08023334444"
    assert payload["wpcargo_shipper_address"] == "Plot 14 Acme Way, Ikeja, Lagos"
    assert payload["wpcargo_receiver_name"] == "Musa Danjuma"
    assert payload["wpcargo_receiver_phone"] == "08031112222"
    assert payload["wpcargo_receiver_address"] == "12 Ahmadu Bello Way, Garki, Abuja"
    assert payload["wpcargo_product"] == "cartons of soap"
    assert payload["wpcargo_qty"] == "50"
    assert payload["wpcargo_weight"] == "900 kg"
    assert payload["publish"] == "Publish"
    assert payload["post_status"] == "publish"


async def test_chat_shipments_are_marked_as_unauthenticated_in_origin(db, settings, queue):
    """An operator must be able to see what arrived from an open channel."""
    contact = await _contact(db)
    await create_shipment(
        _ctx(db, settings, {
            "contact_id": str(contact),
            "communication_id": str(await _message(db, contact)),
            "order": ORDER,
        })
    )

    async with db.connection() as conn:
        cur = await conn.execute("SELECT created_via FROM shipments")
        assert (await cur.fetchone())["created_via"] == "CHAT"


async def test_an_incomplete_order_is_refused(db, settings, queue):
    """delegate.py only sends complete orders; reaching here means the payload
    was hand-enqueued or tampered with."""
    contact = await _contact(db)
    with pytest.raises(PermanentFailure, match="incomplete order"):
        await create_shipment(
            _ctx(db, settings, {
                "contact_id": str(contact),
                "communication_id": str(await _message(db, contact)),
                "order": {"destination": "Abuja"},
            })
        )


async def test_the_draft_is_cleared_once_the_order_is_placed(db, settings, queue):
    contact = await _contact(db)
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE channel_contacts SET draft = '{\"destination\": \"Abuja\"}'"
            " WHERE id = %s",
            (contact,),
        )

    await create_shipment(
        _ctx(db, settings, {
            "contact_id": str(contact),
            "communication_id": str(await _message(db, contact)),
            "order": ORDER,
        })
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT draft, last_shipment_id FROM channel_contacts WHERE id = %s",
            (contact,),
        )
        row = await cur.fetchone()
    assert row["draft"] is None
    assert row["last_shipment_id"] is not None


# ------------------------------------------------------------ rate limit


async def test_one_contact_cannot_flood_the_system(db, settings, queue):
    """Anyone can message a Telegram bot. This is what stops one conversation
    becoming fifty inventory reservations."""
    contact = await _contact(db)
    message = await _message(db, contact)

    for _ in range(MAX_SHIPMENTS_PER_HOUR + 3):
        await create_shipment(
            _ctx(db, settings, {
                "contact_id": str(contact),
                "communication_id": str(message),
                "order": ORDER,
            })
        )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM shipments WHERE origin_contact_id = %s",
            (contact,),
        )
        assert (await cur.fetchone())["n"] == MAX_SHIPMENTS_PER_HOUR


async def test_the_customer_is_told_when_rate_limited(db, settings, queue):
    contact = await _contact(db)
    message = await _message(db, contact)
    for _ in range(MAX_SHIPMENTS_PER_HOUR + 1):
        await create_shipment(
            _ctx(db, settings, {
                "contact_id": str(contact),
                "communication_id": str(message),
                "order": ORDER,
            })
        )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT body FROM communications"
            " WHERE direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1"
        )
        assert "paused new ones" in (await cur.fetchone())["body"]


async def test_a_different_contact_is_not_affected(db, settings, queue):
    """The limit is per contact, not global — one abuser must not block
    everyone else."""
    busy = await _contact(db, "888")
    message = await _message(db, busy)
    for _ in range(MAX_SHIPMENTS_PER_HOUR):
        await create_shipment(
            _ctx(db, settings, {
                "contact_id": str(busy), "communication_id": str(message), "order": ORDER,
            })
        )

    other = await _contact(db, "999")
    await create_shipment(
        _ctx(db, settings, {
            "contact_id": str(other),
            "communication_id": str(await _message(db, other)),
            "order": ORDER,
        })
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM shipments WHERE origin_contact_id = %s", (other,)
        )
        assert (await cur.fetchone())["n"] == 1


# -------------------------------------------------------- change requests


async def test_a_change_request_goes_to_the_approval_queue(db, settings, repo, policy, reference):
    """The agent tells the customer it is passed on. It does not happen."""
    shipment = await repo.create(reference=reference, state=S.IN_TRANSIT)
    contact = await _contact(db)

    result = await change_request(
        _ctx(
            db, settings,
            {
                "contact_id": str(contact),
                "communication_id": str(await _message(db, contact)),
                "kind": "address",
                "detail": "deliver to Wuse instead",
            },
            shipment=shipment, policy=policy, kind="support.change_request",
        )
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT action, state, policy_decision, rationale FROM proposed_actions"
            " WHERE shipment_id = %s",
            (shipment.id,),
        )
        proposal = await cur.fetchone()

    assert proposal["action"] == "change_delivery_address"
    assert proposal["policy_decision"] == "REQUIRE_APPROVAL"
    assert proposal["state"] == "PROPOSED", "proposing must never apply the change"
    assert "Wuse" in proposal["rationale"]
    assert result.events[0].type == "customer.change_requested"


async def test_a_cancellation_is_also_gated(db, settings, repo, policy, reference):
    shipment = await repo.create(reference=reference, state=S.IN_TRANSIT)
    contact = await _contact(db)

    await change_request(
        _ctx(
            db, settings,
            {
                "contact_id": str(contact),
                "communication_id": str(await _message(db, contact)),
                "kind": "cancellation",
                "detail": "please cancel",
            },
            shipment=shipment, policy=policy, kind="support.change_request",
        )
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT action, policy_decision FROM proposed_actions WHERE shipment_id = %s",
            (shipment.id,),
        )
        proposal = await cur.fetchone()
    assert proposal["action"] == "cancel_shipment"
    assert proposal["policy_decision"] == "REQUIRE_APPROVAL"


async def test_the_shipment_state_is_untouched_by_a_change_request(
    db, settings, repo, policy, reference
):
    shipment = await repo.create(reference=reference, state=S.IN_TRANSIT)
    contact = await _contact(db)

    result = await change_request(
        _ctx(
            db, settings,
            {
                "contact_id": str(contact),
                "communication_id": str(await _message(db, contact)),
                "kind": "address", "detail": "move it",
            },
            shipment=shipment, policy=policy, kind="support.change_request",
        )
    )
    assert result.transition is None


# ------------------------------------------------------------ escalation


async def test_escalation_flags_the_contact(db, settings, queue):
    contact = await _contact(db)
    await escalate(
        _ctx(
            db, settings,
            {"contact_id": str(contact), "reason": "customer is unhappy"},
            kind="support.escalate",
        )
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT escalated_at, escalation_reason FROM channel_contacts WHERE id = %s",
            (contact,),
        )
        row = await cur.fetchone()
    assert row["escalated_at"] is not None
    assert row["escalation_reason"] == "customer is unhappy"


async def test_escalation_without_a_contact_is_refused(db, settings, queue):
    with pytest.raises(PermanentFailure, match="contact_id"):
        await escalate(_ctx(db, settings, {"reason": "x"}, kind="support.escalate"))

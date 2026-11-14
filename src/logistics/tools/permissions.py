"""§34 — which agent may call which tool.

Prose in a specification cannot refuse anything. This is the same table as
data, applied on every call, and a test asserts that no tool is granted to
nobody and no name is granted that does not exist.

The sets are deliberately tight. An agent's remit should be legible here
without reading its implementation, and the question "can the support agent
spend money" should be answerable by looking at one screen of text. It cannot:
`book_carrier` appears against `carrier` and `exception` only.
"""

from __future__ import annotations

AGENT_TOOLS: dict[str, set[str]] = {
    # The orchestrator is a Postgres state machine with no model and no tools.
    # It routes work; the agents it routes to are the ones that act.
    "orchestrator": set(),

    "order": {
        "get_shipment",
        "get_inventory",
    },

    "warehouse": {
        "get_shipment",
        "get_inventory",
        "reserve_inventory",
        "release_inventory",
    },

    "planning": {
        "get_shipment",
        "get_warehouses",
        "calculate_eta",
    },

    "carrier": {
        "get_shipment",
        "get_carriers",
        "get_carrier_rates",
        "send_message",
        "book_carrier",
    },

    # Detection is deterministic and never calls a model, but it reads widely.
    # No write of any kind: a detector that can change what it is watching is
    # a detector whose findings mean nothing.
    "tracking": {
        "get_shipment",
        "get_tracking",
        "calculate_eta",
    },

    # The broadest remit, and the only agent whose reasoning is model-driven
    # end to end. It can re-source and reroute — both tier 3, both gated — and
    # it can ask for a human rather than guessing.
    "exception": {
        "get_shipment",
        "get_tracking",
        "get_carriers",
        "get_carrier_rates",
        "calculate_eta",
        "book_carrier",
        "reroute_shipment",
        "send_message",
        "create_approval_request",
    },

    # Talks to customers, so it can send. It deliberately cannot book, reroute,
    # or touch stock: a customer asking for something expensive should produce
    # a request through the orchestrator, not a purchase.
    "support": {
        "get_shipment",
        "get_tracking",
        "calculate_eta",
        "send_message",
    },

    # Reads everything, changes nothing. An analyst that can act on its own
    # conclusions is not an analyst.
    "analytics": {
        "get_shipment",
        "get_tracking",
        "get_carriers",
    },
}


def install(registry) -> None:  # noqa: ANN001 - avoids a circular import
    for agent, tools in AGENT_TOOLS.items():
        registry.grant(agent, tools)

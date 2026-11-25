"""Step handlers.

Importing this package registers every handler. The worker looks steps up by
kind, so a module missing from the imports below means shipments stall at that
step — the worker marks the item DEAD with "no handler registered", which is
loud on purpose.

Registered today:
    order.validate            Order Agent — deterministic checks, then the model
    warehouse.allocate        rules
    planning.plan             rules
    carrier.source            broadcasts to carriers, opens the quote window
    carrier.close_window      scores quotes, proposes, hits the policy gate
    carrier.book              the only step that spends money
    approval.escalate         an unanswered approval is a failure, not a wait
    approval.expire           resolves one nobody answered
    approval.granted          human said yes → book
    approval.refused          human said no → source again
    channels.configure        applies a channel change from Settings
    channels.poll             pulls customer messages off every live channel
    support.reply             decides intent, replies, delegates to the orchestrator
    support.create_shipment   a chat booking enters the normal pipeline
    support.change_request    routed through the policy gate, never applied
    support.escalate          hands the conversation to a person
    tracking.mark_in_transit  departure
    tracking.mark_delivered   arrival
    tracking.raise_exception  detection fired
    analytics.report          Analytics Agent — SQL computes, the model explains
    detection.sweep           absence detection, self-rescheduling
    exception.investigate     Exception Agent — reasons, proposes, never acts
    exception.await_approval  raises the approval a resolution needs
    customer.notify           proactive outbound on the customer's channel
    shipment.assist           answers an operator's question; reads only
    pod.verify                Proof of Delivery verification before close-out
    shipment.close            terminal
"""

from logistics.handlers import (  # noqa: F401
    allocate,
    analytics,
    approval,
    assist,
    book,
    close,
    channel_config,
    channels as channel_steps,
    close_window,
    exception,
    notify,
    plan,
    pod,
    source,
    support_actions,
    tracking,
    validate,
)
from logistics.handlers.base import (
    HandlerError,
    PermanentFailure,
    StepContext,
    handler,
    registry,
)

__all__ = [
    "HandlerError",
    "PermanentFailure",
    "StepContext",
    "handler",
    "registry",
]

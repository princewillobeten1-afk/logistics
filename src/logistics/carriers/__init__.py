"""Carrier sourcing.

One `CarrierAdapter` contract, several transports. API carriers answer in
milliseconds with structured data; Telegram carriers answer in forty minutes,
in free text, or never. The workflow is written for the harder case, so the
easy one is a special case of it rather than the other way round.
"""

from logistics.carriers.adapter import (
    CarrierAdapter,
    CarrierRef,
    LoadRequest,
    Quote,
    QuoteState,
    TenderResult,
)
from logistics.carriers.scoring import WEIGHTS, ScoreBreakdown, score_quotes

__all__ = [
    "WEIGHTS",
    "CarrierAdapter",
    "CarrierRef",
    "LoadRequest",
    "Quote",
    "QuoteState",
    "ScoreBreakdown",
    "TenderResult",
    "score_quotes",
]

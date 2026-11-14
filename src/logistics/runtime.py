"""Event loop selection.

psycopg's async driver cannot run on Windows' default ProactorEventLoop and
raises InterfaceError on the first connection. Every entry point that runs a
coroutine goes through here so the right loop is chosen once, in one place,
rather than being rediscovered at each call site.

Harmless on Linux, where the default loop is already a selector loop — which
matters, because production will not be Windows.
"""

from __future__ import annotations

import asyncio
import selectors
import sys
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")


def loop_factory() -> asyncio.AbstractEventLoop:
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop(selectors.SelectSelector())
    return asyncio.new_event_loop()


def run(coro: Coroutine[Any, Any, T]) -> T:
    """asyncio.run on a loop psycopg can actually use."""
    return asyncio.run(coro, loop_factory=loop_factory)

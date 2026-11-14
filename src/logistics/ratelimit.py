"""Client-side rate limiting.

Shared: the model layer sits under NIM's ~40 RPM ceiling, and the Telegram
adapter under ~1 msg/sec per chat and ~30/sec globally. Both are bursty
workloads against a hard cap, which is exactly what a token bucket is for.
"""

from __future__ import annotations

import asyncio
import time


class TokenBucket:
    """Async token bucket. Refills continuously at `rate_per_minute`."""

    def __init__(self, rate_per_minute: float, burst: int | None = None) -> None:
        if rate_per_minute <= 0:
            raise ValueError("rate_per_minute must be positive")
        self._rate_per_s = rate_per_minute / 60.0
        self._capacity = float(
            burst if burst is not None else max(1, int(rate_per_minute // 6))
        )
        self._tokens = self._capacity
        self._updated = time.monotonic()
        self._lock = asyncio.Lock()

    @property
    def capacity(self) -> float:
        return self._capacity

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._updated
        if elapsed > 0:
            self._tokens = min(self._capacity, self._tokens + elapsed * self._rate_per_s)
            self._updated = now

    async def acquire(self, tokens: float = 1.0) -> float:
        """Block until `tokens` are available. Returns seconds waited."""
        if tokens > self._capacity:
            raise ValueError(f"cannot acquire {tokens} from a bucket of {self._capacity}")

        waited = 0.0
        while True:
            async with self._lock:
                self._refill()
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return waited
                deficit = tokens - self._tokens
                delay = deficit / self._rate_per_s
            await asyncio.sleep(delay)
            waited += delay


class PerKeyLimiter:
    """A bucket per key, plus a global one.

    Telegram enforces both at once: ~1 msg/sec to any single chat *and* ~30/sec
    across all of them. Respecting only the global limit gets a busy chat
    throttled; respecting only the per-chat one gets the whole bot throttled.
    """

    def __init__(
        self,
        *,
        per_key_rate_per_minute: float,
        global_rate_per_minute: float,
        per_key_burst: int = 1,
        global_burst: int = 5,
    ) -> None:
        self._per_key_rate = per_key_rate_per_minute
        self._per_key_burst = per_key_burst
        self._buckets: dict[str, TokenBucket] = {}
        self._global = TokenBucket(global_rate_per_minute, burst=global_burst)
        self._lock = asyncio.Lock()

    async def acquire(self, key: str) -> float:
        async with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = TokenBucket(self._per_key_rate, burst=self._per_key_burst)
                self._buckets[key] = bucket

        waited = await bucket.acquire()
        return waited + await self._global.acquire()

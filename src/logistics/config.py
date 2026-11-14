"""Runtime configuration. Everything comes from the environment.

No credential is ever hardcoded or committed. NVIDIA_API_KEY is read from the
process environment or a local .env that is gitignored.
"""

from __future__ import annotations

import os
import socket
from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- database -------------------------------------------------------
    database_url: str = "postgresql://logistics:logistics@localhost:5433/logistics"
    db_pool_min: int = 2
    db_pool_max: int = 10

    # --- model provider (NVIDIA NIM, OpenAI-compatible) -----------------
    nvidia_api_key: SecretStr | None = None
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    llm_timeout_s: float = 120.0

    # --- route optimization (NVIDIA cuOpt Managed Service) --------------
    nvidia_cuopt_url: str = "https://optimize.api.nvidia.com/v1/nvidia/cuopt"
    nvidia_cuopt_status_url: str = "https://optimize.api.nvidia.com/v1/status"
    nvidia_cuopt_api_key: SecretStr | None = None
    cuopt_time_limit_s: float = 5.0
    cuopt_poll_timeout_s: float = 30.0

    # Hosted build.nvidia.com defaults to ~40 RPM. We sit deliberately under
    # it, because bursts — not the daily average — are what trip the limit.
    llm_max_rpm: int = 30
    llm_max_concurrency: int = 4
    llm_max_attempts: int = 3

    # --- channel credentials --------------------------------------------
    # Fernet key encrypting channel credentials at rest in Postgres. Generate
    # with `python -m logistics.cli generate-key`. Without it, saving a secret
    # raises rather than writing plaintext.
    credentials_key: SecretStr | None = None

    # --- carrier messaging (Telegram) -----------------------------------
    # From @BotFather. Chosen over WhatsApp because it needs no business
    # verification, no Meta review and no template approval. The one real
    # constraint is that a bot cannot open a conversation: a carrier must
    # message the bot once before it can be asked to quote.
    telegram_bot_token: SecretStr | None = None
    telegram_poll_seconds: int = 30

    # --- WPCargo customer shipment portal -------------------------------
    # External WordPress + WPCargo portal where the support agent registers
    # customer and shipment details before handing off to the orchestrator.
    wpcargo_url: str | None = None
    wpcargo_username: str | None = None
    wpcargo_password: SecretStr | None = None

    # --- worker ---------------------------------------------------------
    worker_id: str = Field(default_factory=_default_worker_id)
    worker_concurrency: int = 4
    worker_poll_interval_s: float = 1.0
    worker_idle_backoff_s: float = 5.0
    # Must exceed the slowest handler, or a live worker's item gets reclaimed
    # underneath it and runs twice.
    worker_lease_s: int = 300
    worker_reclaim_interval_s: float = 30.0

    # --- retry ----------------------------------------------------------
    retry_base_delay_s: float = 2.0
    retry_max_delay_s: float = 600.0

    # --- observability --------------------------------------------------
    log_level: str = "INFO"
    log_json: bool = False

    @property
    def has_llm(self) -> bool:
        return self.nvidia_api_key is not None

    @property
    def cuopt_key(self) -> SecretStr | None:
        return self.nvidia_cuopt_api_key or self.nvidia_api_key

    @property
    def has_cuopt(self) -> bool:
        return bool(self.nvidia_cuopt_url and self.cuopt_key is not None)

    @property
    def has_telegram(self) -> bool:
        return self.telegram_bot_token is not None

    @property
    def has_wpcargo(self) -> bool:
        return bool(
            self.wpcargo_url
            and self.wpcargo_username
            and self.wpcargo_password is not None
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

"""Channel configuration, credential encryption, and inbound routing."""

from __future__ import annotations

import pytest

from logistics.channels.base import ChannelKind, ChannelStatus, Inbound
from logistics.channels.crypto import (
    CredentialsNotConfigured,
    decrypt,
    encrypt,
    generate_key,
    mask,
)
from logistics.channels.inbound import InboundRouter, extract_reference
from logistics.channels.registry import provider_for, providers
from logistics.channels.store import ChannelStore


@pytest.fixture
def crypto_key(monkeypatch):
    """A real key, isolated per test."""
    from logistics.config import get_settings

    key = generate_key()
    monkeypatch.setenv("CREDENTIALS_KEY", key)
    get_settings.cache_clear()
    yield key
    get_settings.cache_clear()


@pytest.fixture
def no_crypto_key(monkeypatch):
    """No key at all.

    Clearing the environment variable is not enough — pydantic-settings also
    reads .env, which on a configured machine has one. Patch the accessor so
    the test sees a genuinely unconfigured system.
    """
    import logistics.channels.crypto as crypto
    from logistics.config import Settings

    monkeypatch.setattr(
        crypto, "get_settings", lambda: Settings(credentials_key=None, _env_file=None)
    )
    yield


# ------------------------------------------------------------ encryption


def test_credentials_round_trip(crypto_key):
    blob = encrypt({"bot_token": "123:SECRET"})
    assert decrypt(blob) == {"bot_token": "123:SECRET"}


def test_ciphertext_does_not_contain_the_secret(crypto_key):
    """The point of encrypting at rest: a table dump yields nothing usable."""
    blob = encrypt({"bot_token": "123:VERYSECRET"})
    assert b"VERYSECRET" not in blob
    assert b"bot_token" not in blob


def test_saving_without_a_key_raises_rather_than_storing_plaintext(no_crypto_key):
    with pytest.raises(CredentialsNotConfigured, match="never written unencrypted"):
        encrypt({"bot_token": "secret"})


def test_a_wrong_key_will_not_decrypt(crypto_key, monkeypatch):
    from logistics.config import get_settings

    blob = encrypt({"bot_token": "secret"})
    monkeypatch.setenv("CREDENTIALS_KEY", generate_key())
    get_settings.cache_clear()

    from logistics.channels.crypto import CredentialsUnreadable

    with pytest.raises(CredentialsUnreadable, match="most likely changed"):
        decrypt(blob)


def test_empty_credentials_decrypt_to_nothing(crypto_key):
    assert decrypt(None) == {}
    assert decrypt(b"") == {}


def test_mask_keeps_only_a_recognisable_tail():
    masked = mask("123456:ABCDEF")
    assert masked.endswith("CDEF")
    assert "123456" not in masked
    assert len(masked) == len("123456:ABCDEF")
    # Shorter than the tail: reveal nothing at all.
    assert mask("abc") == "•••"
    assert mask(None) == "—"


# -------------------------------------------------------------- providers


def test_every_channel_has_a_provider():
    for kind in ChannelKind:
        assert provider_for(kind).kind is kind


def test_every_provider_declares_its_fields():
    for provider in providers():
        assert provider.fields, f"{provider.kind} declares no credential fields"
        assert provider.label and provider.description


def test_secret_fields_are_marked():
    """A field not marked secret is stored in plaintext config and rendered."""
    assert any(f.secret for f in provider_for(ChannelKind.TELEGRAM).fields)
    assert any(f.secret for f in provider_for(ChannelKind.GMAIL).fields)
    # The widget has no secret — origins are public by nature.
    assert not any(f.secret for f in provider_for(ChannelKind.WIDGET).fields)


async def test_telegram_rejects_an_empty_token():
    result = await provider_for(ChannelKind.TELEGRAM).verify({}, {})
    assert result.ok is False


async def test_widget_requires_a_scheme_on_origins():
    provider = provider_for(ChannelKind.WIDGET)
    bad = await provider.verify({"allowed_origins": "yourcompany.com"}, {})
    assert bad.ok is False
    assert "scheme" in bad.message

    good = await provider.verify({"allowed_origins": "https://yourcompany.com"}, {})
    assert good.ok is True
    assert good.config["site_key"].startswith("lgw_")


async def test_widget_keeps_an_existing_site_key():
    """Re-verifying must not invalidate a snippet already pasted into a site."""
    provider = provider_for(ChannelKind.WIDGET)
    result = await provider.verify(
        {"allowed_origins": "https://a.com"}, {"site_key": "lgw_existing"}
    )
    assert result.config["site_key"] == "lgw_existing"


async def test_push_channels_have_nothing_to_poll():
    for kind in (ChannelKind.WHATSAPP, ChannelKind.WIDGET):
        messages, cursor = await provider_for(kind).fetch({}, {}, "5")
        assert messages == []
        assert cursor == "5"


# ------------------------------------------------------------------ store


async def test_channels_are_seeded_unconfigured(db):
    connections = await ChannelStore(db).all()
    assert {str(c.channel) for c in connections} == {
        "TELEGRAM", "WHATSAPP", "GMAIL", "WIDGET"
    }
    assert all(c.state is ChannelStatus.UNCONFIGURED for c in connections)
    assert all(not c.enabled for c in connections)


async def test_a_failed_verify_is_not_stored_as_connected(db, crypto_key):
    store = ChannelStore(db)
    ok, message = await store.save(
        ChannelKind.TELEGRAM, {"bot_token": "obviously-not-a-real-token"}
    )

    assert ok is False
    connection = await store.get(ChannelKind.TELEGRAM)
    assert connection.state is ChannelStatus.ERROR
    assert connection.enabled is False


async def test_cannot_enable_an_unverified_channel(db, crypto_key):
    store = ChannelStore(db)
    ok, message = await store.set_enabled(ChannelKind.GMAIL, True)
    assert ok is False
    assert "verify" in message.lower()


async def test_widget_connects_and_can_go_live(db, crypto_key):
    store = ChannelStore(db)
    ok, _ = await store.save(
        ChannelKind.WIDGET, {"allowed_origins": "https://acme.com"}
    )
    assert ok is True

    connection = await store.get(ChannelKind.WIDGET)
    assert connection.state is ChannelStatus.VERIFIED
    assert connection.config["site_key"]

    enabled, _ = await store.set_enabled(ChannelKind.WIDGET, True)
    assert enabled is True
    assert (await store.get(ChannelKind.WIDGET)).live is True


async def test_connection_object_never_carries_a_secret(db, crypto_key):
    """The shape the dashboard renders must not be able to leak a token."""
    store = ChannelStore(db)
    await store.save(ChannelKind.WIDGET, {"allowed_origins": "https://acme.com"})

    connection = await store.get(ChannelKind.WIDGET)
    assert not hasattr(connection, "credentials")
    assert "•" in "".join(connection.masked.values()) or connection.masked == {}


async def test_disconnect_forgets_everything(db, crypto_key):
    store = ChannelStore(db)
    await store.save(ChannelKind.WIDGET, {"allowed_origins": "https://acme.com"})
    await store.disconnect(ChannelKind.WIDGET)

    connection = await store.get(ChannelKind.WIDGET)
    assert connection.state is ChannelStatus.UNCONFIGURED
    assert connection.config == {}
    assert await store.credentials(ChannelKind.WIDGET) == {}


async def test_blank_secret_keeps_the_stored_one(db, crypto_key):
    """So an operator can edit a phone number without re-pasting a token."""
    store = ChannelStore(db)
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE channel_connections SET credentials = %s, state = 'VERIFIED'"
            " WHERE channel = 'WHATSAPP'",
            (encrypt({"access_token": "keep-me", "phone_number_id": "111"}),),
        )

    # Submitting with a blank token must not wipe it.
    await store.save(ChannelKind.WHATSAPP, {"access_token": "", "phone_number_id": "222"})
    stored = await store.credentials(ChannelKind.WHATSAPP)
    assert stored["access_token"] == "keep-me"


# ------------------------------------------------------- inbound routing


def test_reference_extraction():
    assert extract_reference("where is LG-82931?") == "LG-82931"
    assert extract_reference("my order demo-001 please") == "DEMO-001"
    assert extract_reference("Re: SIM-LATE update") == "SIM-LATE"


def test_ordinary_words_are_not_references():
    assert extract_reference("where is my order?") is None
    assert extract_reference("thanks - bye") is None


async def test_a_message_with_a_reference_finds_its_shipment(db, repo, reference):
    shipment = await repo.create(reference=reference)
    routed = await InboundRouter(db).route(
        Inbound(
            channel=ChannelKind.TELEGRAM,
            external_id="555",
            text=f"any update on {reference}?",
        )
    )

    assert routed.shipment_id == shipment.id
    assert routed.reference == reference
    assert routed.needs_reference is False


async def test_a_message_without_one_asks_rather_than_guesses(db):
    routed = await InboundRouter(db).route(
        Inbound(channel=ChannelKind.TELEGRAM, external_id="556", text="where is my order?")
    )
    assert routed.shipment_id is None
    assert routed.needs_reference is True


async def test_a_follow_up_remembers_the_last_shipment(db, repo, reference):
    """Someone who asked about LG-82931 a minute ago is still asking about it."""
    shipment = await repo.create(reference=reference)
    router = InboundRouter(db)

    await router.route(
        Inbound(channel=ChannelKind.TELEGRAM, external_id="557", text=f"about {reference}")
    )
    follow_up = await router.route(
        Inbound(channel=ChannelKind.TELEGRAM, external_id="557", text="is it late?")
    )

    assert follow_up.shipment_id == shipment.id
    assert follow_up.needs_reference is False


async def test_an_unknown_reference_does_not_invent_a_shipment(db):
    routed = await InboundRouter(db).route(
        Inbound(channel=ChannelKind.TELEGRAM, external_id="558", text="where is XX-99999?")
    )
    assert routed.shipment_id is None


async def test_a_redelivered_message_is_not_answered_twice(db, repo, reference):
    """Providers retry webhooks. Two replies to one question is a real failure."""
    await repo.create(reference=reference)
    router = InboundRouter(db)
    message = Inbound(
        channel=ChannelKind.TELEGRAM,
        external_id="559",
        text=f"status of {reference}",
        external_ref="update-42",
    )

    first = await router.route(message)
    second = await router.route(message)

    assert first is not None
    assert second is None


async def test_the_contact_is_recorded_once_per_channel(db):
    router = InboundRouter(db)
    for text in ("hello", "still there?"):
        await router.route(
            Inbound(channel=ChannelKind.TELEGRAM, external_id="560", text=text)
        )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM channel_contacts WHERE external_id = '560'"
        )
        assert (await cur.fetchone())["n"] == 1


async def test_the_same_id_on_two_channels_is_two_contacts(db):
    router = InboundRouter(db)
    await router.route(Inbound(channel=ChannelKind.TELEGRAM, external_id="x", text="hi"))
    await router.route(Inbound(channel=ChannelKind.GMAIL, external_id="x", text="hi"))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM channel_contacts WHERE external_id = 'x'"
        )
        assert (await cur.fetchone())["n"] == 2

"""Authentication, sessions and roles.

Until this existed, `/approvals` would authorise carrier spending for anyone
who could reach the port, recording whoever the form said had done it.
"""

from __future__ import annotations

import uuid

import pytest

from logistics.auth import (
    _GRANTS,
    AuthError,
    AuthRepo,
    Permission,
    Role,
    hash_password,
    may,
    verify_password,
)
from logistics.db import Database, current_org


@pytest.fixture
def auth(db: Database) -> AuthRepo:
    return AuthRepo(db)


@pytest.fixture
async def account(auth: AuthRepo):
    async def make(role: Role = Role.VIEWER, email: str | None = None):
        return await auth.create_user(
            org_id=current_org.get(),
            email=email or f"{uuid.uuid4().hex[:8]}@example.com",
            password="correct horse battery staple",
            role=role,
        )

    return make


# ------------------------------------------------------------- passwords


def test_a_password_round_trips():
    stored = hash_password("s3cret")
    assert verify_password("s3cret", stored)
    assert not verify_password("s3cre", stored)


def test_the_same_password_hashes_differently_each_time():
    """Per-password salt. Identical hashes would tell anyone who reads the
    table which accounts share a password."""
    assert hash_password("same") != hash_password("same")


def test_the_hash_records_its_own_parameters():
    """So the cost can be raised later without invalidating what is stored."""
    scheme, n, r, p, salt, digest = hash_password("x").split("$")
    assert scheme == "scrypt"
    assert int(n) >= 2**14
    assert len(bytes.fromhex(salt)) == 16


def test_a_malformed_hash_does_not_let_anyone_in():
    for junk in ("", "x", "scrypt$bad", "$$$$$", "plaintext-password"):
        assert not verify_password("password", junk)


def test_an_empty_password_is_refused_at_the_source():
    with pytest.raises(ValueError, match="must not be empty"):
        hash_password("")


# ----------------------------------------------------------------- roles


def test_only_an_approver_or_admin_may_approve():
    assert may(Role.APPROVER, Permission.APPROVE)
    assert may(Role.ADMIN, Permission.APPROVE)
    assert not may(Role.DISPATCHER, Permission.APPROVE)
    assert not may(Role.VIEWER, Permission.APPROVE)


def test_an_approver_cannot_also_arrange_the_shipment():
    """Segregation of duties. Whoever authorises the spend should not be the
    one who set it up — that is the entire reason approval exists."""
    assert not may(Role.APPROVER, Permission.EDIT_SHIPMENT)
    assert may(Role.DISPATCHER, Permission.EDIT_SHIPMENT)


def test_a_viewer_can_only_read():
    assert may(Role.VIEWER, Permission.READ)
    for p in (Permission.EDIT_SHIPMENT, Permission.APPROVE, Permission.ADMINISTER):
        assert not may(Role.VIEWER, p)


def test_only_an_admin_administers():
    for role in (Role.VIEWER, Role.DISPATCHER, Role.APPROVER):
        assert not may(role, Permission.ADMINISTER)
    assert may(Role.ADMIN, Permission.ADMINISTER)


def test_an_unknown_role_grants_nothing():
    """Fails closed, like the policy gate. A typo in a role name must not read
    as permission."""
    for p in Permission:
        assert not may("SUPERUSER", p)
        assert not may("", p)


async def test_a_deactivated_user_loses_every_permission(account):
    from dataclasses import replace

    user = await account(Role.ADMIN)
    assert user.may(Permission.APPROVE)
    assert not replace(user, active=False).may(Permission.APPROVE)


# ------------------------------------------------------------- accounts


async def test_a_user_can_sign_in(auth: AuthRepo, account):
    user = await account(Role.DISPATCHER)
    token, signed_in = await auth.login(user.email, "correct horse battery staple")
    assert signed_in.id == user.id
    assert signed_in.role is Role.DISPATCHER
    assert len(token) > 30


async def test_email_case_and_padding_do_not_matter(auth: AuthRepo, account):
    user = await account(email="Ada@Example.COM")
    assert user.email == "ada@example.com"
    token, _ = await auth.login("  ADA@example.com  ", "correct horse battery staple")
    assert token


async def test_a_wrong_password_is_refused(auth: AuthRepo, account):
    user = await account()
    with pytest.raises(AuthError):
        await auth.login(user.email, "wrong")


async def test_an_unknown_account_fails_the_same_way(auth: AuthRepo, account):
    """Identical error for both, so the message cannot be used to find out who
    has an account here."""
    user = await account()
    unknown, wrong = None, None
    try:
        await auth.login("nobody@example.com", "whatever")
    except AuthError as exc:
        unknown = str(exc)
    try:
        await auth.login(user.email, "whatever")
    except AuthError as exc:
        wrong = str(exc)
    assert unknown == wrong


async def test_a_deactivated_account_cannot_sign_in(auth: AuthRepo, db, account):
    user = await account()
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active = false WHERE id = %s", (user.id,))
    with pytest.raises(AuthError):
        await auth.login(user.email, "correct horse battery staple")


# ------------------------------------------------------------- sessions


async def test_a_session_resolves_to_its_user(auth: AuthRepo, account):
    user = await account(Role.APPROVER)
    token, _ = await auth.login(user.email, "correct horse battery staple")
    resolved = await auth.resolve(token)
    assert resolved is not None
    assert resolved.id == user.id
    assert resolved.org_id == current_org.get()


async def test_no_token_resolves_to_nobody(auth: AuthRepo):
    assert await auth.resolve(None) is None
    assert await auth.resolve("") is None
    assert await auth.resolve("not-a-real-token") is None


async def test_signing_out_revokes_the_session(auth: AuthRepo, account):
    user = await account()
    token, _ = await auth.login(user.email, "correct horse battery staple")
    await auth.logout(token)
    assert await auth.resolve(token) is None


async def test_an_expired_session_does_not_resolve(auth: AuthRepo, db, account):
    user = await account()
    token, _ = await auth.login(user.email, "correct horse battery staple")
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET expires_at = now() - interval '1 hour'"
            " WHERE token = %s", (token,)
        )
    assert await auth.resolve(token) is None


async def test_deactivating_a_user_kills_their_live_sessions(auth: AuthRepo, db, account):
    """Revocation has to take effect on the next request, not at the next
    login — otherwise dismissing someone leaves them signed in for a fortnight."""
    user = await account(Role.ADMIN)
    token, _ = await auth.login(user.email, "correct horse battery staple")
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active = false WHERE id = %s", (user.id,))
    assert await auth.resolve(token) is None


async def test_changing_a_password_revokes_every_session(auth: AuthRepo, account):
    """A reset is usually prompted by a suspected compromise. Leaving the
    intruder's session alive would defeat the point of resetting."""
    user = await account()
    token, _ = await auth.login(user.email, "correct horse battery staple")
    assert await auth.resolve(token) is not None

    await auth.set_password(user.email, "a different password entirely")
    assert await auth.resolve(token) is None
    assert await auth.login(user.email, "a different password entirely")


async def test_expired_sessions_can_be_swept(auth: AuthRepo, db, account):
    user = await account()
    token, _ = await auth.login(user.email, "correct horse battery staple")
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET expires_at = now() - interval '1 day' WHERE token = %s",
            (token,),
        )
    assert await auth.purge_expired() >= 1


# -------------------------------------------------------------- tenancy


def test_the_dashboard_grants_the_same_permissions_as_python():
    """Two runtimes, one `users` table.

    The dashboard decides in TypeScript whether to show the Approve button and
    whether the action may run; the worker decides in Python. If the two grant
    tables drift, one of them authorises something the other refuses — and the
    direction that matters is the dashboard being more permissive, which is
    silent until someone spends money they should not have been able to.
    """
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "lib" / "auth.ts").read_text(
        encoding="utf-8"
    )
    block = re.search(r"const GRANTS[^{]*\{(.*?)\n\};", source, re.S)
    assert block, "GRANTS table not found in lib/auth.ts"

    ts_grants = {
        role: set(re.findall(r'"(\w+)"', perms))
        for role, perms in re.findall(r"(\w+):\s*\[([^\]]*)\]", block.group(1))
    }
    py_grants = {
        str(role): {str(p) for p in perms} for role, perms in _GRANTS.items()
    }

    assert ts_grants == py_grants, (
        "lib/auth.ts and src/logistics/auth.py disagree about who may do what"
    )


async def test_listing_users_is_scoped_to_one_org(auth: AuthRepo, account, other_org):
    """`users` sits outside RLS deliberately — a login has no org context yet
    — so this is the one place scoping is done by hand, and the one place it
    could be forgotten."""
    ours = await account(Role.ADMIN)
    theirs = await auth.create_user(
        org_id=other_org, email="them@other.example", password="x" * 12, role=Role.ADMIN
    )

    listed = {u.id for u in await auth.list_users(current_org.get())}
    assert ours.id in listed
    assert theirs.id not in listed

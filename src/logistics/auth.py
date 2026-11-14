"""Authentication and roles.

`hashlib.scrypt` from the standard library rather than bcrypt or argon2: it
adds no dependency, and it is what both the worker and the dashboard's Node
side would have to agree on anyway. Sessions are rows, so revocation is a
DELETE and there is no signing secret to share between the two runtimes.

Nothing here is tenant-scoped through RLS — `users` and `sessions` sit outside
it deliberately (see migration 016). A login has no org context yet; resolving
one is the whole point of the call. Every query below is therefore keyed by
something unguessable or unique on its own: a session token, or an email.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any
from uuid import UUID

from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)

SESSION_TTL = timedelta(days=14)
TOKEN_BYTES = 32

# scrypt parameters. n=2**14 costs ~50ms per hash on ordinary hardware, which
# is slow enough to make offline cracking expensive and fast enough that a
# login does not feel broken. The values are stored in the hash string, so
# raising them later does not invalidate existing passwords.
_N, _R, _P = 2**14, 8, 1


class Role(StrEnum):
    VIEWER = "VIEWER"
    DISPATCHER = "DISPATCHER"
    APPROVER = "APPROVER"
    ADMIN = "ADMIN"

    @property
    def rank(self) -> int:
        return _RANK[self]


# Roles are ordered for reading, but *not* for authority: an APPROVER is not a
# superset of a DISPATCHER. Approving spend and creating shipments are separate
# duties, and collapsing them into one ladder is how segregation of duties
# quietly disappears. `may()` below treats ADMIN as the only true superset.
_RANK = {Role.VIEWER: 0, Role.DISPATCHER: 1, Role.APPROVER: 2, Role.ADMIN: 3}


class Permission(StrEnum):
    READ = "READ"
    EDIT_SHIPMENT = "EDIT_SHIPMENT"
    APPROVE = "APPROVE"
    ADMINISTER = "ADMINISTER"


_GRANTS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: frozenset({Permission.READ}),
    Role.DISPATCHER: frozenset({Permission.READ, Permission.EDIT_SHIPMENT}),
    # Deliberately not EDIT_SHIPMENT: whoever authorises the spend should not
    # also be the one who arranged it.
    Role.APPROVER: frozenset({Permission.READ, Permission.APPROVE}),
    Role.ADMIN: frozenset(Permission),
}


def may(role: Role | str, permission: Permission) -> bool:
    try:
        return permission in _GRANTS[Role(role)]
    except ValueError:
        # An unrecognised role grants nothing. Fails closed, like everything
        # else that decides what someone is allowed to do.
        return False


class AuthError(Exception):
    """Raised for any failed authentication. Deliberately one type with one
    message — distinguishing "no such user" from "wrong password" tells an
    attacker which half of a guess was right."""


@dataclass(frozen=True, slots=True)
class User:
    id: UUID
    org_id: UUID
    email: str
    name: str | None
    role: Role
    active: bool

    def may(self, permission: Permission) -> bool:
        return self.active and may(self.role, permission)


# ------------------------------------------------------------- passwords


def hash_password(password: str) -> str:
    """Format: scrypt$n$r$p$salt$hash — self-describing, so the parameters can
    be raised later without invalidating anything already stored."""
    if not password:
        raise ValueError("password must not be empty")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=64
    )
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        computed = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p),
            dklen=len(digest_hex) // 2,
        )
    except (ValueError, TypeError):
        # A malformed hash is not a reason to let someone in.
        return False
    return hmac.compare_digest(computed.hex(), digest_hex)


# -------------------------------------------------------------- accounts


class AuthRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def create_org(self, name: str, slug: str) -> UUID:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "INSERT INTO organisations (name, slug) VALUES (%s, %s)"
                " ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name"
                " RETURNING id",
                (name, slug),
            )
            row = await cur.fetchone()
        return row["id"]

    async def create_user(
        self, *, org_id: UUID, email: str, password: str, role: Role,
        name: str | None = None,
    ) -> User:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "INSERT INTO users (org_id, email, password_hash, role, name)"
                " VALUES (%s, %s, %s, %s, %s)"
                " RETURNING id, org_id, email, name, role, active",
                (org_id, email.strip().lower(), hash_password(password),
                 Role(role).value, name),
            )
            row = await cur.fetchone()
        log.info("auth.user_created", email=email, role=str(role))
        return _user(row)

    async def set_password(self, email: str, password: str) -> bool:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "UPDATE users SET password_hash = %s WHERE lower(email) = %s",
                (hash_password(password), email.strip().lower()),
            )
        if cur.rowcount:
            # Changing a password revokes every existing session. Otherwise a
            # reset prompted by a suspected compromise leaves the intruder
            # signed in.
            await self.revoke_all(email)
            return True
        return False

    async def get_by_email(self, email: str) -> dict[str, Any] | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT id, org_id, email, name, role, active, password_hash"
                "  FROM users WHERE lower(email) = %s",
                (email.strip().lower(),),
            )
            return await cur.fetchone()

    async def list_users(self, org_id: UUID) -> list[User]:
        """Scoped by hand, because `users` is outside RLS."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT id, org_id, email, name, role, active FROM users"
                " WHERE org_id = %s ORDER BY email",
                (org_id,),
            )
            return [_user(row) for row in await cur.fetchall()]

    # -------------------------------------------------------- sign in/out

    async def login(
        self, email: str, password: str, *,
        ip: str | None = None, user_agent: str | None = None,
    ) -> tuple[str, User]:
        row = await self.get_by_email(email)

        # Hash even when the user does not exist, so a missing account and a
        # wrong password take the same time. Otherwise the response latency
        # enumerates who has an account here.
        stored = row["password_hash"] if row else _DUMMY_HASH
        ok = verify_password(password, stored)

        if row is None or not ok or not row["active"]:
            log.warning("auth.login_failed", email=email, ip=ip)
            raise AuthError("invalid email or password")

        token = secrets.token_urlsafe(TOKEN_BYTES)
        expires = datetime.now(UTC) + SESSION_TTL
        async with self._db.connection() as conn:
            await conn.execute(
                "INSERT INTO sessions (token, user_id, expires_at, ip_address, user_agent)"
                " VALUES (%s, %s, %s, %s, %s)",
                (token, row["id"], expires, ip, (user_agent or "")[:500] or None),
            )
            await conn.execute(
                "UPDATE users SET last_login_at = now() WHERE id = %s", (row["id"],)
            )
        log.info("auth.login", email=email, role=row["role"])
        return token, _user(row)

    async def resolve(self, token: str | None) -> User | None:
        """Session token to user, or None. Touches `last_seen_at` so an idle
        session can be distinguished from an abandoned one."""
        if not token:
            return None
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT u.id, u.org_id, u.email, u.name, u.role, u.active"
                "  FROM sessions s JOIN users u ON u.id = s.user_id"
                " WHERE s.token = %s AND s.expires_at > now()",
                (token,),
            )
            row = await cur.fetchone()
            if row is None or not row["active"]:
                return None
            await conn.execute(
                "UPDATE sessions SET last_seen_at = now() WHERE token = %s", (token,)
            )
        return _user(row)

    async def logout(self, token: str) -> None:
        async with self._db.connection() as conn:
            await conn.execute("DELETE FROM sessions WHERE token = %s", (token,))

    async def revoke_all(self, email: str) -> int:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "DELETE FROM sessions WHERE user_id IN"
                " (SELECT id FROM users WHERE lower(email) = %s)",
                (email.strip().lower(),),
            )
        return cur.rowcount

    async def purge_expired(self) -> int:
        async with self._db.connection() as conn:
            cur = await conn.execute("DELETE FROM sessions WHERE expires_at < now()")
        return cur.rowcount


def _user(row: dict[str, Any]) -> User:
    return User(
        id=row["id"], org_id=row["org_id"], email=row["email"],
        name=row["name"], role=Role(row["role"]), active=row["active"],
    )


# A real hash of a value nobody can supply, used to keep the timing of a
# failed login independent of whether the account exists.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(32))

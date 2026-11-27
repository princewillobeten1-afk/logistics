import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const CONNECTOR_KEY_PREFIX = "ct_live_";
export const WEBHOOK_SECRET_PREFIX = "whsec_";

function getSecretEncryptionKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_KEY?.trim();
  if (!raw) return null;
  return createHash("sha256").update(raw, "utf8").digest();
}

export function sealWebhookSecret(plaintext: string): string {
  const key = getSecretEncryptionKey();
  if (!key) return `plain:${plaintext}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function unsealWebhookSecret(stored: string): string {
  if (stored.startsWith("plain:")) return stored.slice(6);
  if (stored.startsWith("enc:")) {
    const key = getSecretEncryptionKey();
    if (!key) return stored;
    const parts = stored.slice(4).split(".");
    if (parts.length !== 3) return stored;
    try {
      const iv = Buffer.from(parts[0], "base64url");
      const tag = Buffer.from(parts[1], "base64url");
      const enc = Buffer.from(parts[2], "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch {
      return stored;
    }
  }
  return stored;
}

export function verifySameOriginRequest(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  const expectedHost = (
    headers.get("x-forwarded-host") ??
    headers.get("host") ??
    ""
  )
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (!expectedHost) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

export function generateConnectorApiKey(): {
  plaintext: string;
  prefix: string;
  hash: string;
} {
  const raw = randomBytes(24).toString("base64url");
  const plaintext = `${CONNECTOR_KEY_PREFIX}${raw}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 16),
    hash: hashSecret(plaintext),
  };
}

export function generateWebhookSecret(): {
  plaintext: string;
  sealed: string;
  hash: string;
} {
  const plaintext = `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    sealed: sealWebhookSecret(plaintext),
    hash: hashSecret(plaintext),
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function timingSafeHexEquals(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function signWebhookPayload(rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const trimmed = signatureHeader.trim();
  const providedHex = trimmed.startsWith("sha256=") ? trimmed.slice(7) : trimmed;
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;
  const expectedHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return timingSafeHexEquals(providedHex.toLowerCase(), expectedHex.toLowerCase());
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // Cloud metadata / link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // Multicast / reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::" || lower.startsWith("::ffff:")) {
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (isIP(v4) === 4) return isPrivateOrReservedIpv4(v4);
    }
    return true;
  }
  // Unique local fc00::/7 (fc.. / fd..) and link-local fe80::/10
  if (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

export function validateOutboundWebhookUrlSyntax(rawUrl: string): {
  ok: boolean;
  normalizedUrl?: string;
  error?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: true, normalizedUrl: undefined };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Outbound webhook URL must be a valid URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Outbound webhook URL must use https:// or http://." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "Outbound webhook URL must not embed credentials." };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    return { ok: false, error: "Outbound webhook URL is missing a hostname." };
  }

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return {
      ok: false,
      error: "Outbound webhook URL cannot target localhost or internal hostnames.",
    };
  }

  if (isIP(host) !== 0 && isBlockedIpAddress(host)) {
    return {
      ok: false,
      error: "Outbound webhook URL cannot target private, loopback, or metadata IP addresses.",
    };
  }

  return { ok: true, normalizedUrl: parsed.toString() };
}

export async function validateOutboundWebhookUrlForDispatch(rawUrl: string): Promise<{
  ok: boolean;
  normalizedUrl?: string;
  error?: string;
}> {
  const syntax = validateOutboundWebhookUrlSyntax(rawUrl);
  if (!syntax.ok || !syntax.normalizedUrl) return syntax;

  const parsed = new URL(syntax.normalizedUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(host) === 0) {
    try {
      const addresses = await lookup(host, { all: true });
      if (!addresses.length) {
        return { ok: false, error: "Outbound webhook hostname could not be resolved." };
      }
      for (const addr of addresses) {
        if (isBlockedIpAddress(addr.address)) {
          return {
            ok: false,
            error: "Outbound webhook hostname resolves to a restricted network address.",
          };
        }
      }
    } catch {
      return { ok: false, error: "Outbound webhook DNS lookup failed." };
    }
  }

  return syntax;
}

export function validateDatabaseUrlSyntax(rawUrl: string): {
  ok: boolean;
  host?: string;
  port?: number;
  database?: string;
  error?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, error: "PostgreSQL connection URL is required." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: "Database URL must be a valid postgres:// or postgresql:// URI.",
    };
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return {
      ok: false,
      error: "Only postgres:// and postgresql:// connection URIs are supported for live database sync.",
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    return { ok: false, error: "Database URL is missing a hostname." };
  }

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return {
      ok: false,
      error: "Database URL cannot target localhost or internal network hostnames.",
    };
  }

  if (isIP(host) !== 0 && isBlockedIpAddress(host)) {
    return {
      ok: false,
      error: "Database URL cannot target private, loopback, or metadata IP addresses.",
    };
  }

  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "Database URL has an invalid port number." };
  }

  const database = parsed.pathname.replace(/^\//, "").trim() || undefined;
  return { ok: true, host, port, database };
}

export async function validateDatabaseUrlForConnect(rawUrl: string): Promise<{
  ok: boolean;
  host?: string;
  port?: number;
  database?: string;
  error?: string;
}> {
  const syntax = validateDatabaseUrlSyntax(rawUrl);
  if (!syntax.ok || !syntax.host) return syntax;

  if (isIP(syntax.host) === 0) {
    try {
      const addresses = await lookup(syntax.host, { all: true });
      if (!addresses.length) {
        return { ok: false, error: "Database hostname could not be resolved." };
      }
      for (const addr of addresses) {
        if (isBlockedIpAddress(addr.address)) {
          return {
            ok: false,
            error: "Database hostname resolves to a restricted network address.",
          };
        }
      }
    } catch {
      return { ok: false, error: "Database hostname DNS lookup failed." };
    }
  }

  return syntax;
}


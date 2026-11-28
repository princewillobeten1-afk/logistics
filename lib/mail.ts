import nodemailer, { type Transporter } from "nodemailer";

// Next dev reloads modules on every edit; without a global the transporter
// would be recreated (and its connection pool leaked) on every reload, the
// same reason lib/db.ts keeps its pool on globalThis.
const globalForMail = globalThis as unknown as { logisticsMailer?: Transporter };

function getSmtpPassword(): string | undefined {
  const pass = process.env.SMTP_PASSWORD ?? process.env.SMTP_PASS;
  return pass && pass.length > 0 ? pass : undefined;
}

function getResendApiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim() || getResendApiKey());
}

function transporter(): Transporter | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  if (globalForMail.logisticsMailer) return globalForMail.logisticsMailer;

  const port = Number(process.env.SMTP_PORT ?? 587);
  const secureEnv = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure =
    secureEnv === "true" ? true : secureEnv === "false" ? false : port === 465;
  const user = process.env.SMTP_USER?.trim();

  const t = nodemailer.createTransport({
    host,
    port,
    // 465 uses implicit TLS; 587/25 start plaintext and upgrade via STARTTLS.
    secure,
    auth: user ? { user, pass: getSmtpPassword() } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });

  if (process.env.NODE_ENV !== "production") globalForMail.logisticsMailer = t;
  return t;
}

const FROM =
  process.env.RESEND_FROM?.trim() ||
  process.env.SMTP_FROM?.trim() ||
  "Control Tower <no-reply@localhost>";

export type MailSendResult = {
  ok: boolean;
  provider: "smtp" | "resend" | "none";
  error?: string;
};

/**
 * Send a transactional email — password resets and account lifecycle notices.
 * Supports SMTP (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD) and Resend
 * HTTP API (RESEND_API_KEY).
 */
export async function sendMailDetail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<MailSendResult> {
  const t = transporter();
  if (t) {
    try {
      await t.sendMail({
        from: FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      return { ok: true, provider: "smtp" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("mail: SMTP send failed", message.to, err);
      // Fall through to Resend if also configured; otherwise report failure.
      if (!getResendApiKey()) {
        return { ok: false, provider: "smtp", error: msg };
      }
    }
  }

  const resendKey = getResendApiKey();
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("mail: Resend send failed", res.status, errBody);
        return {
          ok: false,
          provider: "resend",
          error: `Resend returned ${res.status}`,
        };
      }
      return { ok: true, provider: "resend" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("mail: Resend request failed", message.to, err);
      return { ok: false, provider: "resend", error: msg };
    }
  }

  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `mail: Neither SMTP_HOST nor RESEND_API_KEY is set; transactional email was not dispatched externally.\n` +
        `  to: ${message.to}\n  subject: ${message.subject}\n`,
    );
  } else {
    console.error(
      "mail: Neither SMTP_HOST nor RESEND_API_KEY is configured in production.",
    );
  }
  return {
    ok: false,
    provider: "none",
    error: "No outbound mail provider configured.",
  };
}

export async function sendMail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  const result = await sendMailDetail(message);
  return result.ok;
}

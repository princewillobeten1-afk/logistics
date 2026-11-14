import nodemailer, { type Transporter } from "nodemailer";

// Next dev reloads modules on every edit; without a global the transporter
// would be recreated (and its connection pool leaked) on every reload, the
// same reason lib/db.ts keeps its pool on globalThis.
const globalForMail = globalThis as unknown as { logisticsMailer?: Transporter };

function transporter(): Transporter | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  if (globalForMail.logisticsMailer) return globalForMail.logisticsMailer;

  const t = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    // 465 is implicit TLS; 587/25 start plaintext and upgrade. Getting this
    // wrong against a real provider produces a hang, not a clean error, so it
    // is explicit rather than guessed from the port.
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });

  if (process.env.NODE_ENV !== "production") globalForMail.logisticsMailer = t;
  return t;
}

const FROM = process.env.SMTP_FROM || "Control Tower <no-reply@localhost>";

/**
 * Send a transactional email — password resets today, and anything else the
 * platform needs to say outside the app itself.
 *
 * Deliberately separate from the Gmail channel provider in
 * `src/logistics/channels/providers.py`. That one sends *as* one
 * organisation's own connected Gmail account, replying inside a customer's
 * shipment thread, and its credentials only exist once that org has
 * configured the channel — a chicken-and-egg problem for a password reset on
 * day one, before any org has configured anything. This is the platform's own
 * outbound line: one SMTP relay, configured once via SMTP_*, shared by every
 * tenant, and used only for messages about the account itself rather than
 * shipment correspondence.
 *
 * Without SMTP_HOST configured, this logs the message instead of sending it
 * and returns false. Every caller has to behave correctly either way —
 * requestPasswordReset in lib/auth.ts always reports the same outcome to the
 * visitor regardless, so a missing SMTP config fails towards "developer can
 * see the link in the server log" rather than towards a broken-looking flow.
 */
export async function sendMail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  const t = transporter();
  if (!t) {
    console.warn(
      `mail: SMTP_HOST is not set, so this was logged instead of sent.\n` +
        `  to: ${message.to}\n  subject: ${message.subject}\n\n${message.text}\n`,
    );
    return false;
  }

  try {
    await t.sendMail({
      from: FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return true;
  } catch (err) {
    // A failed send must not throw into the caller: requestPasswordReset
    // reports the same generic success either way, so an outage here should
    // not turn into a stack trace for the visitor — it turns into a support
    // ticket instead, which is the correct amount of visibility.
    console.error("mail: send failed", message.to, err);
    return false;
  }
}

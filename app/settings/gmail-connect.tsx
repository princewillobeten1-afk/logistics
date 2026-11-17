"use client";

import { useCallback, useEffect, useState } from "react";
import {
  connectGmailWithGoogle,
  getGmailAccessToken,
  getGmailAccountEmail,
  googleSignOut,
  initGoogleAuth,
} from "@/lib/google-auth";

type GmailMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  messageId?: string;
  snippet: string;
  unread: boolean;
};

type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
};

export function GmailConnect({ compact = false }: { compact?: boolean }) {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [profile, setProfile] = useState<GmailProfile | null>(null);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Reply / compose state
  const [replyTarget, setReplyTarget] = useState<GmailMessage | null>(null);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const loadInbox = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride ?? getGmailAccessToken();
    if (!token) {
      setNeedsAuth(true);
      return;
    }
    setLoadingInbox(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail/messages", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        setNeedsAuth(true);
        setProfile(null);
        setMessages([]);
        setError("Gmail access expired. Please sign in with Google again.");
        return;
      }
      const data = (await res.json()) as {
        profile?: GmailProfile;
        messages?: GmailMessage[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Failed to read Gmail inbox.");
        return;
      }
      setProfile(data.profile ?? null);
      setMessages(data.messages ?? []);
      setNeedsAuth(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Gmail.");
    } finally {
      setLoadingInbox(false);
    }
  }, []);

  useEffect(() => {
    const unsub = initGoogleAuth(
      (_user, token) => {
        setNeedsAuth(false);
        void loadInbox(token);
      },
      () => {
        setNeedsAuth(true);
        setProfile(null);
        setMessages([]);
      },
    );
    return () => unsub();
  }, [loadInbox]);

  async function handleConnect() {
    setError(null);
    setNotice(null);
    setConnecting(true);
    try {
      const { accessToken } = await connectGmailWithGoogle();
      setNeedsAuth(false);
      await loadInbox(accessToken);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        code === "auth/popup-closed-by-user" ||
        code === "auth/cancelled-popup-request"
      ) {
        setError("Gmail sign-in was cancelled before completing.");
      } else if (code === "auth/popup-blocked") {
        setError(
          "Your browser blocked the Google popup. Allow popups and try again.",
        );
      } else if (code === "auth/unauthorized-domain") {
        setError(
          `Gmail sign-in is not authorized for ${typeof window !== "undefined" ? window.location.hostname : "this domain"}.`,
        );
      } else if (code === "auth/operation-not-allowed") {
        setError("Google sign-in provider is not enabled for this project.");
      } else if (code === "auth/network-request-failed") {
        setError("Network error while contacting Google. Please try again.");
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Could not connect your Gmail account.",
        );
      }
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await googleSignOut();
    setNeedsAuth(true);
    setProfile(null);
    setMessages([]);
    setReplyTarget(null);
    setComposeTo("");
    setComposeSubject("");
    setComposeBody("");
    setNotice("Disconnected Gmail mailbox from this session.");
  }

  function startReply(msg: GmailMessage) {
    setReplyTarget(msg);
    setComposeTo(msg.from);
    setComposeSubject(
      msg.subject.toLowerCase().startsWith("re:")
        ? msg.subject
        : `Re: ${msg.subject}`,
    );
    setComposeBody("");
    setNotice(null);
    setError(null);
  }

  function openSendConfirmation(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!composeTo.trim() || !composeSubject.trim() || !composeBody.trim()) {
      setError("Recipient, subject, and message are required.");
      return;
    }
    setConfirmOpen(true);
  }

  async function confirmAndSend() {
    const token = getGmailAccessToken();
    if (!token) {
      setConfirmOpen(false);
      setNeedsAuth(true);
      setError("Gmail session expired. Please sign in with Gmail again.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to: composeTo.trim(),
          subject: composeSubject.trim(),
          message: composeBody.trim(),
          threadId: replyTarget?.threadId,
          inReplyTo: replyTarget?.messageId,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        if (res.status === 401) {
          setNeedsAuth(true);
        }
        setError(data.error ?? "Could not send email through Gmail.");
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      setNotice(`Sent email to ${composeTo.trim()}.`);
      setReplyTarget(null);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      await loadInbox(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email.");
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  }

  const connectedEmail = profile?.emailAddress || getGmailAccountEmail();

  if (needsAuth) {
    return (
      <div className="gmail-box">
        {!compact ? (
          <ol className="setup">
            <li>Sign in with the Google account that hosts your support mailbox</li>
            <li>Grant permission to read incoming support mail and send replies</li>
            <li>
              Inbound messages appear immediately in your live support view
            </li>
          </ol>
        ) : null}

        {error ? <p className="channel-error">{error}</p> : null}
        {notice ? (
          <p className="auth-notice" role="status">
            {notice}
          </p>
        ) : null}

        <div className="gmail-cta">
          <button
            type="button"
            className="gsi-material-button"
            onClick={handleConnect}
            disabled={connecting}
            aria-busy={connecting}
          >
            <div className="gsi-material-button-state" />
            <div className="gsi-material-button-content-wrapper">
              <div className="gsi-material-button-icon">
                <svg
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  style={{ display: "block" }}
                  aria-hidden="true"
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                  <path fill="none" d="M0 0h48v48H0z" />
                </svg>
              </div>
              <span className="gsi-material-button-contents">
                {connecting ? "Connecting Gmail…" : "Sign in with Gmail"}
              </span>
              <span style={{ display: "none" }}>Sign in with Gmail</span>
            </div>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gmail-box">
      <dl className="connected-facts">
        <div>
          <dt>mailbox</dt>
          <dd>{connectedEmail || "Connected"}</dd>
        </div>
        {profile ? (
          <div>
            <dt>inbox threads</dt>
            <dd>{profile.threadsTotal.toLocaleString()}</dd>
          </div>
        ) : null}
        <div>
          <dt>status</dt>
          <dd>Connected with Google</dd>
        </div>
      </dl>

      {error ? <p className="channel-error">{error}</p> : null}
      {notice ? (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="channel-buttons" style={{ marginBottom: "0.875rem" }}>
        <button
          type="button"
          onClick={() => void loadInbox()}
          disabled={loadingInbox}
        >
          {loadingInbox ? "Refreshing…" : "Refresh inbox"}
        </button>
        <button
          type="button"
          className="danger"
          onClick={handleDisconnect}
        >
          Disconnect Gmail
        </button>
      </div>

      {messages.length > 0 ? (
        <div className="gmail-inbox">
          <div className="gmail-inbox-head">
            <span>Recent inbox messages</span>
            <span>{messages.length} shown</span>
          </div>
          <ul className="gmail-list">
            {messages.map((m) => (
              <li key={m.id} data-unread={m.unread}>
                <div className="gmail-row-top">
                  <strong>{m.subject}</strong>
                  <button
                    type="button"
                    className="gmail-reply-btn"
                    onClick={() => startReply(m)}
                  >
                    Reply
                  </button>
                </div>
                <div className="gmail-meta">
                  <span>{m.from}</span>
                  {m.date ? <span>{m.date}</span> : null}
                </div>
                {m.snippet ? <p className="gmail-snippet">{m.snippet}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : !loadingInbox ? (
        <p className="prose-note">No inbox messages returned.</p>
      ) : null}

      <form onSubmit={openSendConfirmation} className="channel-form" style={{ marginTop: "1rem" }}>
        <label htmlFor="gmail-to">
          <span>{replyTarget ? "Replying to" : "Send support email to"}</span>
          <input
            id="gmail-to"
            type="email"
            value={composeTo}
            onChange={(e) => setComposeTo(e.target.value)}
            placeholder="customer@example.com"
            required
          />
        </label>
        <label htmlFor="gmail-subject">
          <span>Subject</span>
          <input
            id="gmail-subject"
            type="text"
            value={composeSubject}
            onChange={(e) => setComposeSubject(e.target.value)}
            placeholder="Shipment update"
            required
          />
        </label>
        <label htmlFor="gmail-body">
          <span>Message</span>
          <textarea
            id="gmail-body"
            rows={3}
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            placeholder="Write a reply…"
            required
          />
        </label>
        <div className="channel-buttons">
          <button type="submit" disabled={sending}>
            Send via Gmail
          </button>
          {replyTarget ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                setReplyTarget(null);
                setComposeTo("");
                setComposeSubject("");
                setComposeBody("");
              }}
            >
              Cancel reply
            </button>
          ) : null}
        </div>
      </form>

      {confirmOpen ? (
        <div
          className="confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gmail-confirm-title"
        >
          <div className="confirm-modal">
            <h4 id="gmail-confirm-title">Confirm sending email</h4>
            <p>
              This will send an email directly from{" "}
              <strong>{connectedEmail || "your Gmail account"}</strong>.
            </p>
            <dl className="kv">
              <dt>to</dt>
              <dd>{composeTo}</dd>
              <dt>subject</dt>
              <dd>{composeSubject}</dd>
            </dl>
            <pre className="json" style={{ marginTop: "0.75rem", maxHeight: 160 }}>
              {composeBody}
            </pre>
            <div className="channel-buttons" style={{ marginTop: "1rem" }}>
              <button
                type="button"
                onClick={confirmAndSend}
                disabled={sending}
              >
                {sending ? "Sending…" : "Confirm & send"}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => setConfirmOpen(false)}
                disabled={sending}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

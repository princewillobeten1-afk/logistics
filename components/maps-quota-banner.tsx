"use client";

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { isQuotaErrorMessage } from "@/lib/maps-grounding";

export const GMP_QUOTA_EVENT = "gmp-quota-exceeded";

export function dispatchQuotaExceeded(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GMP_QUOTA_EVENT));
  }
}

// Tier 1: Register global Maps JS quota/auth listeners immediately at module
// load so early SDK script errors are captured before child components mount.
const globalWindow =
  typeof window !== "undefined"
    ? (window as Window & {
        gm_authFailure?: () => void;
        __gmpQuotaTapInstalled?: boolean;
      })
    : null;

if (globalWindow && !globalWindow.__gmpQuotaTapInstalled) {
  globalWindow.__gmpQuotaTapInstalled = true;

  const prevAuthFailure = globalWindow.gm_authFailure;
  globalWindow.gm_authFailure = () => {
    prevAuthFailure?.();
    dispatchQuotaExceeded();
  };

  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    origConsoleError.apply(console, args);
    const msg = args.map((a) => String(a)).join(" ");
    if (isQuotaErrorMessage(msg)) {
      dispatchQuotaExceeded();
    }
  };
}

export function MapsQuotaBanner() {
  const [quotaReached, setQuotaReached] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handleQuota = () => {
      setQuotaReached(true);
      setDismissed(false);
    };
    window.addEventListener(GMP_QUOTA_EVENT, handleQuota);
    return () => {
      window.removeEventListener(GMP_QUOTA_EVENT, handleQuota);
    };
  }, []);

  if (!quotaReached || dismissed) return null;

  return (
    <div className="quota-banner" role="alert" aria-live="polite">
      <div className="quota-banner-inner">
        <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
        <span>
          Google Maps Platform quota reached. If you are the app owner, visit{" "}
          <a
            href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
            target="_blank"
            rel="noopener noreferrer"
          >
            maps developer site
          </a>{" "}
          for instructions to update your account.
        </span>
      </div>
      <button
        type="button"
        className="quota-banner-dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss Google Maps quota notice"
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

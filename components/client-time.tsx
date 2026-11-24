"use client";

import { useEffect, useState } from "react";
import { relative, when, whenUtc } from "@/lib/format";

function toIsoAttribute(date: Date | string | null): string | undefined {
  if (!date) return undefined;
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/**
 * Hydration-safe date/time display for Client Components.
 * Renders a deterministic UTC string during SSR and initial hydration, then
 * switches to the browser's local timezone/locale after mount.
 */
export function ClientWhen({ date }: { date: Date | string | null }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const label = mounted ? when(date) : whenUtc(date);
  const iso = toIsoAttribute(date);

  return <time dateTime={iso}>{label}</time>;
}

/**
 * Hydration-safe relative timestamp for Client Components.
 * Renders a deterministic UTC string during SSR and initial hydration so
 * `Date.now()` elapsed seconds never cause text/attribute hydration mismatches.
 */
export function ClientRelative({ date }: { date: Date | string | null }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const label = mounted ? relative(date) : whenUtc(date);
  const iso = toIsoAttribute(date);

  return <time dateTime={iso}>{label}</time>;
}

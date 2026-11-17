"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Route } from "lucide-react";
import { triggerFleetOptimization } from "@/app/planning/actions";

export function OptimizeFleetButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  function handleClick() {
    setNotice(null);
    startTransition(async () => {
      const res = await triggerFleetOptimization();
      setNotice({ ok: res.ok, text: res.message });
      if (res.ok) {
        router.refresh();
      }
    });
  }

  return (
    <div className="row-center" style={{ gap: 12, flexWrap: "wrap" }}>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleClick}
        disabled={pending}
      >
        <Route size={15} strokeWidth={2} aria-hidden="true" />
        <span>
          {pending ? "Optimising fleet routes…" : "Optimize Fleet Routes"}
        </span>
      </button>
      {notice ? (
        <span
          className={notice.ok ? "text-muted text-xs" : "text-crit text-xs"}
          role="status"
        >
          {notice.text}
        </span>
      ) : null}
    </div>
  );
}

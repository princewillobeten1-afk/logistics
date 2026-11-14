"use client";

import { useState, useTransition } from "react";
import { triggerFleetOptimization } from "@/app/planning/actions";

export function OptimizeFleetButton() {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  function handleClick() {
    setNotice(null);
    startTransition(async () => {
      const res = await triggerFleetOptimization();
      setNotice({ ok: res.ok, text: res.message });
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
        {pending
          ? "Submitting to NVIDIA cuOpt…"
          : "Optimize Fleet Routes (NVIDIA cuOpt)"}
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


"use client";

import { useState } from "react";
import { CheckCircle2, Info, Lock, RefreshCw } from "lucide-react";
import {
  MixedShipmentsPanel,
  PreArrivalCustomsPanel,
} from "@/components/tactics/tactics-execution-panels";
import {
  InTransitFlowPanel,
  PostponementCentersPanel,
  PrecisionTrackingPanel,
} from "@/components/tactics/tactics-inventory-panels";
import {
  SupplierCollaborationPanel,
  SupplierCommunicationsPanel,
} from "@/components/tactics/tactics-supplier-panels";
import type { Role } from "@/lib/auth";
import type {
  TacticId,
  TacticsWorkspaceSnapshot,
} from "@/lib/tactics/types";

export function TacticsWorkspace({
  initialSnapshot,
  userRole,
}: {
  initialSnapshot: TacticsWorkspaceSnapshot;
  userRole: Role;
}) {
  const [snapshot, setSnapshot] =
    useState<TacticsWorkspaceSnapshot>(initialSnapshot);
  const [activeTactic, setActiveTactic] = useState<TacticId>("communications");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const readOnly = userRole === "VIEWER";

  const refreshSnapshot = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/tactics", { cache: "no-store" });
      const data = (await res.json()) as TacticsWorkspaceSnapshot & {
        error?: string;
      };
      if (!res.ok) {
        setErrorMsg(data.error ?? "Failed to refresh logistics tactics workspace.");
        return;
      }
      setSnapshot(data);
    } catch {
      setErrorMsg("Network error while refreshing logistics tactics.");
    } finally {
      setBusy(false);
    }
  };

  const handleAction = async (
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    setBusy(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/tactics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "ControlTowerTactics",
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as TacticsWorkspaceSnapshot & {
        error?: string;
      };
      if (!res.ok) {
        setErrorMsg(data.error ?? "Action could not be saved.");
        return false;
      }
      setSnapshot(data);
      setSuccessMsg("Saved to tenant operational log.");
      return true;
    } catch {
      setErrorMsg("Network error while saving tactical action.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tac-shell">
      <header className="tac-header">
        <div>
          <p className="tac-kicker">
            Logistics Strategy Playbook · 7 Execution Tactics · {snapshot.orgName}
          </p>
          <h1>Logistics Strategy Tactics</h1>
          <p className="tac-lead">
            Operational workflows for supplier planning cadence, continuous improvement,
            GPS and barcode precision tracking, in-transit flow-through, postponement
            centers, mixed-SKU consolidation, and pre-arrival customs clearance.
          </p>
        </div>

        <button
          type="button"
          className="bi-btn-outline"
          disabled={busy}
          onClick={() => void refreshSnapshot()}
        >
          <RefreshCw
            size={14}
            className={busy ? "bi-spin" : undefined}
            aria-hidden="true"
          />
          <span>{busy ? "Syncing…" : "Refresh"}</span>
        </button>
      </header>

      {readOnly ? (
        <div className="bi-rbac-banner">
          <Lock size={15} aria-hidden="true" />
          <div>
            <strong>Read-only viewer role:</strong> You can inspect all 7 tactics and live
            metrics; Dispatcher, Approver, or Admin permissions are required to execute actions.
          </div>
        </div>
      ) : null}

      {errorMsg ? (
        <div className="bi-error-banner" role="alert">
          <Info size={16} aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      ) : null}

      {successMsg ? (
        <div className="tac-success-banner" role="status">
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>{successMsg}</span>
        </div>
      ) : null}

      {/* 7-Tactic Overview Grid (each item opens its dedicated execution workspace) */}
      <section aria-label="Seven logistics tactics readiness" className="tac-score-grid">
        {snapshot.scorecards.map((card) => {
          const isActive = activeTactic === card.id;
          return (
            <button
              key={card.id}
              type="button"
              className={`tac-score-card${isActive ? " is-active" : ""}`}
              aria-pressed={isActive}
              onClick={() => {
                setActiveTactic(card.id);
                setSuccessMsg(null);
                setErrorMsg(null);
              }}
            >
              <div className="tac-score-top">
                <span className="tac-score-num">0{card.number}</span>
                <span
                  className={`tac-score-status tac-status-${card.status.toLowerCase()}`}
                >
                  {card.status}
                </span>
              </div>
              <span className="tac-score-title">{card.title}</span>
              <strong className="tac-score-val">{card.headlineMetric}</strong>
              <span className="tac-score-detail">{card.detail}</span>
            </button>
          );
        })}
      </section>

      {/* Single-Row Interactive Tactic Switcher */}
      <div
        className="tac-tab-bar"
        role="tablist"
        aria-label="Select logistics tactic workbench"
      >
        {snapshot.scorecards.map((card) => (
          <button
            key={card.id}
            type="button"
            role="tab"
            aria-selected={activeTactic === card.id}
            className={`bi-seg-btn${activeTactic === card.id ? " is-active" : ""}`}
            onClick={() => {
              setActiveTactic(card.id);
              setSuccessMsg(null);
              setErrorMsg(null);
            }}
          >
            {card.shortLabel}
          </button>
        ))}
      </div>

      {/* Active Tactic Execution Workbench */}
      <section aria-label="Active tactic workbench">
        {activeTactic === "communications" ? (
          <SupplierCommunicationsPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        ) : activeTactic === "collaboration" ? (
          <SupplierCollaborationPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        ) : activeTactic === "precision_tracking" ? (
          <PrecisionTrackingPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        ) : activeTactic === "in_transit" ? (
          <InTransitFlowPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        ) : activeTactic === "postponement" ? (
          <PostponementCentersPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        ) : activeTactic === "mixed_shipments" ? (
          <MixedShipmentsPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        ) : (
          <PreArrivalCustomsPanel
            snapshot={snapshot}
            busy={busy}
            readOnly={readOnly}
            onAction={handleAction}
          />
        )}
      </section>
    </div>
  );
}

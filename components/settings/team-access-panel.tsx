"use client";

import { useState } from "react";
import { Check, Copy, Link2, ShieldCheck, UserPlus, UserX, RotateCcw } from "lucide-react";
import { ClientWhen } from "@/components/client-time";
import type { Role } from "@/lib/auth";
import {
  WORKSPACE_DEPARTMENTS,
  type WorkspaceDepartment,
} from "@/lib/departments";
import type {
  WorkspaceInvitation,
  WorkspaceMember,
} from "@/lib/workspace-admin";

interface Props {
  initialMembers: WorkspaceMember[];
  initialInvitations: WorkspaceInvitation[];
  currentUserId: string;
  origin: string;
}

const ROLES: Role[] = ["ADMIN", "DISPATCHER", "APPROVER", "VIEWER"];

const DEPT_LABELS: Record<WorkspaceDepartment, string> = {
  FLEET: "Fleet",
  WAREHOUSE: "Warehouse",
  FREIGHT: "Freight & Carriers",
  ORDERS: "Orders",
  SHIPMENTS: "Shipments",
  FINANCE: "Finance",
  HR: "Human Resources",
  CUSTOMERS: "Customers",
  PROCUREMENT: "Procurement",
  COMPLIANCE: "Compliance",
  CUSTOMS: "Customs",
  BI: "Business Intelligence",
  ANALYTICS: "Analytics",
  SUPPORT: "Support",
};

export function TeamAccessPanel({
  initialMembers,
  initialInvitations,
  currentUserId,
  origin,
}: Props) {
  const [members, setMembers] = useState<WorkspaceMember[]>(initialMembers);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>(initialInvitations);

  // Invite form state
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("DISPATCHER");
  const [selectedDepts, setSelectedDepts] = useState<WorkspaceDepartment[]>([]);
  const [branchesInput, setBranchesInput] = useState("");
  const [expiresHours, setExpiresHours] = useState(72);
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Editing member state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<Role>("DISPATCHER");
  const [editDepts, setEditDepts] = useState<WorkspaceDepartment[]>([]);
  const [editBranches, setEditBranches] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const toggleDept = (
    dept: WorkspaceDepartment,
    list: WorkspaceDepartment[],
    setter: (next: WorkspaceDepartment[]) => void,
  ) => {
    if (list.includes(dept)) {
      setter(list.filter((d) => d !== dept));
    } else {
      setter([...list, dept]);
    }
  };

  async function refreshTeam() {
    const res = await fetch("/api/workspace/team", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as {
        members: WorkspaceMember[];
        invitations: WorkspaceInvitation[];
      };
      setMembers(data.members);
      setInvitations(data.invitations);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    setCreatedLink(null);
    setCreating(true);
    try {
      const branchCodes = branchesInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/workspace/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          departments: role === "ADMIN" ? [] : selectedDepts,
          branchCodes: role === "ADMIN" ? [] : branchCodes,
          expiresInHours: expiresHours,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        invitePath?: string;
      };
      if (!res.ok || !data.ok) {
        setNotice({ tone: "err", text: data.error ?? "Failed to create invitation." });
        return;
      }
      const fullUrl = `${origin.replace(/\/$/, "")}${data.invitePath ?? ""}`;
      setCreatedLink(fullUrl);
      setEmail("");
      setSelectedDepts([]);
      setBranchesInput("");
      setNotice({
        tone: "ok",
        text: "Single-use workspace invitation created. Copy and share the link below.",
      });
      await refreshTeam();
    } catch {
      setNotice({ tone: "err", text: "Network error creating invitation." });
    } finally {
      setCreating(false);
    }
  }

  function startEdit(member: WorkspaceMember) {
    setEditingId(member.id);
    setEditRole(member.role);
    setEditDepts(member.departments);
    setEditBranches(member.branchCodes.join(", "));
    setNotice(null);
  }

  async function saveMember(memberId: string, activeOverride?: boolean) {
    setSavingId(memberId);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { userId: memberId };
      if (activeOverride !== undefined) {
        payload.active = activeOverride;
      } else {
        payload.role = editRole;
        payload.departments = editRole === "ADMIN" ? [] : editDepts;
        payload.branchCodes =
          editRole === "ADMIN"
            ? []
            : editBranches
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
      }

      const res = await fetch("/api/workspace/team", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setNotice({ tone: "err", text: data.error ?? "Could not update member." });
        return;
      }
      setEditingId(null);
      setNotice({
        tone: "ok",
        text:
          activeOverride === false
            ? "Member deactivated and all active sessions revoked immediately."
            : activeOverride === true
              ? "Member reactivated."
              : "Member access scope updated.",
      });
      await refreshTeam();
    } catch {
      setNotice({ tone: "err", text: "Network error updating member." });
    } finally {
      setSavingId(null);
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    setNotice(null);
    const res = await fetch(`/api/workspace/invites?id=${encodeURIComponent(inviteId)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setNotice({ tone: "ok", text: "Invitation revoked." });
      await refreshTeam();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice({ tone: "err", text: data.error ?? "Could not revoke invitation." });
    }
  }

  async function copyCreatedLink() {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Clipboard blocked in some iframe contexts
    }
  }

  return (
    <div className="space-y-6">
      {notice && (
        <div
          className={`rounded-md border px-3.5 py-2.5 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          }`}
        >
          {notice.text}
        </div>
      )}

      {createdLink && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2,var(--bg))] p-3.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
              <Link2 className="h-3.5 w-3.5" />
              Single-Use Invite Link (shown once)
            </span>
            <button
              type="button"
              onClick={copyCreatedLink}
              className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)]"
            >
              {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedLink ? "Copied" : "Copy link"}
            </button>
          </div>
          <code className="block break-all font-mono text-xs text-[var(--fg)]">
            {createdLink}
          </code>
        </div>
      )}

      {/* Invite Form */}
      <form
        onSubmit={handleInvite}
        className="rounded-md border border-[var(--border)] p-4 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <UserPlus className="h-4 w-4 text-[var(--accent)]" />
          Invite Team Member to This Workspace
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">Work email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="dispatcher@company.com"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">Expires in (hours)</span>
            <input
              type="number"
              min={1}
              max={168}
              value={expiresHours}
              onChange={(e) => setExpiresHours(Number(e.target.value) || 72)}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm tabular-nums"
            />
          </label>
        </div>

        {role !== "ADMIN" && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-[var(--fg-muted)]">
                Department access (leave all unchecked for workspace-wide member access)
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {WORKSPACE_DEPARTMENTS.map((dept) => (
                  <label
                    key={dept}
                    className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={selectedDepts.includes(dept)}
                      onChange={() => toggleDept(dept, selectedDepts, setSelectedDepts)}
                    />
                    <span>{DEPT_LABELS[dept]}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium text-[var(--fg-muted)]">
                Branch / Warehouse scope (comma-separated codes or cities, e.g. LOS-WH1, ABUJA)
              </span>
              <input
                type="text"
                value={branchesInput}
                onChange={(e) => setBranchesInput(e.target.value)}
                placeholder="All branches (leave blank) or WH-LAG, WH-ABJ"
                className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
              />
            </label>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-[var(--fg-muted)]">
            {role === "ADMIN"
              ? "Workspace Administrators have full unrestricted access across all departments and branches."
              : "One workspace per email. Invite links expire automatically and can only be accepted once."}
          </span>
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <UserPlus className="h-3.5 w-3.5" />
            {creating ? "Creating..." : "Create Invite Link"}
          </button>
        </div>
      </form>

      {/* Active & Inactive Members Table */}
      <div className="scroller" tabIndex={0} role="region" aria-label="Workspace members">
        <table>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Department scope</th>
              <th scope="col">Branch scope</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isEditing = editingId === m.id;
              return (
                <tr key={m.id}>
                  <td>
                    <div className="font-medium">{m.name || m.email}</div>
                    <div className="text-xs text-[var(--fg-muted)]">{m.email}</div>
                  </td>
                  <td className="ref">
                    {isEditing ? (
                      <select
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value as Role)}
                        className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      m.role
                    )}
                  </td>
                  <td className="text-xs">
                    {isEditing && editRole !== "ADMIN" ? (
                      <div className="grid grid-cols-2 gap-1">
                        {WORKSPACE_DEPARTMENTS.map((dept) => (
                          <label key={dept} className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editDepts.includes(dept)}
                              onChange={() => toggleDept(dept, editDepts, setEditDepts)}
                            />
                            <span>{DEPT_LABELS[dept]}</span>
                          </label>
                        ))}
                      </div>
                    ) : m.role === "ADMIN" ? (
                      <span className="text-[var(--fg-muted)]">All departments (Admin)</span>
                    ) : m.departments.length > 0 ? (
                      m.departments.map((d) => DEPT_LABELS[d]).join(", ")
                    ) : (
                      <span className="text-[var(--fg-muted)]">All departments</span>
                    )}
                  </td>
                  <td className="text-xs font-mono">
                    {isEditing && editRole !== "ADMIN" ? (
                      <input
                        type="text"
                        value={editBranches}
                        onChange={(e) => setEditBranches(e.target.value)}
                        placeholder="WH-LAG, WH-ABJ"
                        className="w-36 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
                      />
                    ) : m.role === "ADMIN" ? (
                      <span className="font-sans text-[var(--fg-muted)]">All branches</span>
                    ) : m.branchCodes.length > 0 ? (
                      m.branchCodes.join(", ")
                    ) : (
                      <span className="font-sans text-[var(--fg-muted)]">All branches</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {m.active ? (
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        Active
                      </span>
                    ) : (
                      <span className="font-medium text-rose-600 dark:text-rose-400">
                        Deactivated
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            disabled={savingId === m.id}
                            onClick={() => saveMember(m.id)}
                            className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded border border-[var(--border)] px-2.5 py-1 text-xs"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(m)}
                            className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--surface)]"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Edit scope
                          </button>
                          {m.id !== currentUserId &&
                            (m.active ? (
                              <button
                                type="button"
                                disabled={savingId === m.id}
                                onClick={() => saveMember(m.id, false)}
                                className="inline-flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                              >
                                <UserX className="h-3.5 w-3.5" />
                                Deactivate
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={savingId === m.id}
                                onClick={() => saveMember(m.id, true)}
                                className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                Reactivate
                              </button>
                            ))}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Invitations History */}
      {invitations.length > 0 && (
        <div className="scroller" tabIndex={0} role="region" aria-label="Team invitations">
          <table>
            <thead>
              <tr>
                <th scope="col">Invited email</th>
                <th scope="col">Role</th>
                <th scope="col">Scope</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono text-xs">{inv.email}</td>
                  <td className="ref">{inv.role}</td>
                  <td className="text-xs text-[var(--fg-muted)]">
                    {inv.role === "ADMIN"
                      ? "Full workspace"
                      : [
                          inv.departments.length > 0
                            ? inv.departments.join(", ")
                            : "All depts",
                          inv.branchCodes.length > 0
                            ? `Branches: ${inv.branchCodes.join(", ")}`
                            : "All branches",
                        ].join(" · ")}
                  </td>
                  <td className="text-xs font-medium">{inv.status}</td>
                  <td className="num text-xs text-[var(--fg-muted)]">
                    <ClientWhen date={inv.expiresAt} />
                  </td>
                  <td>
                    {inv.status === "PENDING" ? (
                      <button
                        type="button"
                        onClick={() => handleRevokeInvite(inv.id)}
                        className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                      >
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--fg-muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

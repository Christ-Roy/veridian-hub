"use client";

import { useState } from "react";
import { toast } from "sonner";

import { NOTIFUSE_PLANS, type NotifusePlan } from "@/lib/notifuse/types";

type PlanSource =
  | "stripe"
  | "manual"
  | "lifetime_site_vitrine"
  | "lifetime_partner"
  | "internal";

const PLAN_SOURCES: PlanSource[] = [
  "manual",
  "stripe",
  "lifetime_site_vitrine",
  "lifetime_partner",
  "internal",
];

export interface NotifuseSummary {
  provisioned: boolean;
  workspace_id?: string | null;
  plan?: string | null;
  plan_source?: string | null;
  suspended_at?: string | null;
  suspended_reason?: string | null;
  deleted_at?: string | null;
}

interface Props {
  tenantId: string;
  email: string;
  initial: NotifuseSummary;
  onChanged?: () => void;
}

interface LiveStatus {
  status?: "active" | "suspended" | "deleted";
  plan?: NotifusePlan;
  monthly_email_quota?: number;
  emails_sent_this_month?: number;
  quota_remaining?: number;
  suspended_at?: string | null;
  suspended_reason?: string | null;
  deleted_at?: string | null;
}

export function NotifuseAdminPanel({ tenantId, email, initial, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "status" | "plan" | "suspend" | "resume" | "delete">(
    null,
  );
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [planDraft, setPlanDraft] = useState<NotifusePlan>(
    (initial.plan as NotifusePlan) ?? "free",
  );
  const [planSourceDraft, setPlanSourceDraft] = useState<PlanSource>(
    (initial.plan_source as PlanSource) ?? "manual",
  );
  const [reasonDraft, setReasonDraft] = useState("");

  if (!initial.provisioned) {
    return <span className="text-xs text-muted-foreground">Notifuse non provisionné</span>;
  }

  async function refreshStatus() {
    setBusy("status");
    try {
      const res = await fetch(`/api/admin/notifuse/status?tenantId=${encodeURIComponent(tenantId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      setLive({
        status: data.status,
        plan: data.plan,
        monthly_email_quota: data.monthly_email_quota,
        emails_sent_this_month: data.emails_sent_this_month,
        quota_remaining: data.quota_remaining,
        suspended_at: data.suspended_at ?? null,
        suspended_reason: data.suspended_reason ?? null,
        deleted_at: data.deleted_at ?? null,
      });
      if (data.plan) setPlanDraft(data.plan as NotifusePlan);
    } catch (e) {
      toast.error(`Status échoué: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  async function applyPlan() {
    setBusy("plan");
    try {
      const res = await fetch("/api/admin/notifuse/update-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          plan: planDraft,
          planSource: planSourceDraft,
          reason: reasonDraft.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      toast.success(`Plan ${planDraft} appliqué (${planSourceDraft})`);
      setReasonDraft("");
      await refreshStatus();
      onChanged?.();
    } catch (e) {
      toast.error(`Update plan échoué: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  async function suspend() {
    const reason = window.prompt(`Raison de la suspension de ${email} ?`);
    if (!reason || !reason.trim()) return;
    setBusy("suspend");
    try {
      const res = await fetch("/api/admin/notifuse/suspend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      toast.success("Tenant Notifuse suspendu");
      await refreshStatus();
      onChanged?.();
    } catch (e) {
      toast.error(`Suspend échoué: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    setBusy("resume");
    try {
      const res = await fetch("/api/admin/notifuse/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      toast.success("Tenant Notifuse réactivé");
      await refreshStatus();
      onChanged?.();
    } catch (e) {
      toast.error(`Resume échoué: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  async function softDelete() {
    if (
      !window.confirm(
        `Soft-delete Notifuse pour ${email} ?\n\n` +
          `Le workspace reste récupérable 30j côté Notifuse. ` +
          `Le tenant Hub n'est PAS supprimé (utiliser /admin/delete-tenant pour ça).`,
      )
    )
      return;
    setBusy("delete");
    try {
      const res = await fetch("/api/admin/notifuse/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      toast.success("Workspace Notifuse soft-deleted");
      await refreshStatus();
      onChanged?.();
    } catch (e) {
      toast.error(`Delete échoué: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  const currentStatus =
    live?.status ??
    (initial.deleted_at ? "deleted" : initial.suspended_at ? "suspended" : "active");
  const currentPlan = live?.plan ?? (initial.plan as NotifusePlan | undefined) ?? "free";

  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={() => {
          if (!open) refreshStatus();
          setOpen(!open);
        }}
        className="text-xs px-2 py-1 rounded bg-blue-100 hover:bg-blue-200 text-blue-800"
        disabled={busy !== null}
      >
        📧 Notifuse
      </button>

      {open && (
        <div className="absolute right-4 mt-2 z-20 w-96 bg-white border border-gray-200 rounded-lg shadow-xl p-4 text-left">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-semibold text-sm">Notifuse — {email}</div>
              <div className="text-xs text-muted-foreground">
                workspace: <code className="bg-gray-100 px-1 rounded">{initial.workspace_id}</code>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="bg-gray-50 rounded p-2 mb-3 text-xs space-y-1">
            <div>
              <span className="text-muted-foreground">Status: </span>
              <span
                className={`font-medium ${
                  currentStatus === "active"
                    ? "text-green-700"
                    : currentStatus === "suspended"
                      ? "text-orange-700"
                      : "text-red-700"
                }`}
              >
                {currentStatus}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Plan actuel: </span>
              <code className="bg-white px-1 rounded">{currentPlan}</code>
              {initial.plan_source && (
                <span className="text-muted-foreground ml-2">
                  (source: {initial.plan_source})
                </span>
              )}
            </div>
            {live && (
              <div>
                <span className="text-muted-foreground">Quota: </span>
                {live.emails_sent_this_month ?? 0} / {live.monthly_email_quota ?? 0}
                <span className="text-muted-foreground ml-1">
                  (reste {live.quota_remaining ?? 0})
                </span>
              </div>
            )}
            {(live?.suspended_at || initial.suspended_at) && (
              <div className="text-orange-700">
                Suspendu le {(live?.suspended_at ?? initial.suspended_at)?.slice(0, 19)}
                {(live?.suspended_reason ?? initial.suspended_reason) &&
                  ` — ${live?.suspended_reason ?? initial.suspended_reason}`}
              </div>
            )}
            {(live?.deleted_at || initial.deleted_at) && (
              <div className="text-red-700">
                Soft-deleted le {(live?.deleted_at ?? initial.deleted_at)?.slice(0, 19)}
              </div>
            )}
            <button
              type="button"
              onClick={refreshStatus}
              disabled={busy !== null}
              className="text-xs text-blue-600 hover:underline mt-1"
            >
              {busy === "status" ? "Refresh..." : "↻ Refresh status"}
            </button>
          </div>

          <div className="space-y-2 mb-3">
            <div className="text-xs font-medium">Changer le plan</div>
            <div className="flex gap-2">
              <select
                value={planDraft}
                onChange={(e) => setPlanDraft(e.target.value as NotifusePlan)}
                className="text-xs px-2 py-1 border rounded flex-1"
              >
                {NOTIFUSE_PLANS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                value={planSourceDraft}
                onChange={(e) => setPlanSourceDraft(e.target.value as PlanSource)}
                className="text-xs px-2 py-1 border rounded"
              >
                {PLAN_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={reasonDraft}
              onChange={(e) => setReasonDraft(e.target.value)}
              placeholder="Raison (optionnel, audit log)"
              className="text-xs px-2 py-1 border rounded w-full"
            />
            <button
              type="button"
              onClick={applyPlan}
              disabled={busy !== null}
              className="text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 w-full"
            >
              {busy === "plan" ? "Application..." : `Appliquer plan ${planDraft}`}
            </button>
          </div>

          <div className="flex gap-2 pt-3 border-t">
            {currentStatus === "suspended" ? (
              <button
                type="button"
                onClick={resume}
                disabled={busy !== null}
                className="text-xs px-2 py-1 rounded bg-green-100 hover:bg-green-200 text-green-800 flex-1"
              >
                {busy === "resume" ? "..." : "▶ Resume"}
              </button>
            ) : currentStatus === "active" ? (
              <button
                type="button"
                onClick={suspend}
                disabled={busy !== null}
                className="text-xs px-2 py-1 rounded bg-orange-100 hover:bg-orange-200 text-orange-800 flex-1"
              >
                {busy === "suspend" ? "..." : "⏸ Suspend"}
              </button>
            ) : null}
            {currentStatus !== "deleted" && (
              <button
                type="button"
                onClick={softDelete}
                disabled={busy !== null}
                className="text-xs px-2 py-1 rounded bg-red-100 hover:bg-red-200 text-red-800 flex-1"
              >
                {busy === "delete" ? "..." : "🗑 Soft-delete"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

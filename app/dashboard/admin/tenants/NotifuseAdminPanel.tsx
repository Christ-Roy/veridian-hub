"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Mail } from "lucide-react";

import { NOTIFUSE_PLANS, type NotifusePlan } from "@/lib/notifuse/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  // Étapes de confirmation : suspension demande une raison, soft-delete une
  // confirmation. Remplacent les window.prompt() / window.confirm() natifs.
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

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
      toast.error(`Status échoué : ${e instanceof Error ? e.message : "?"}`);
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
      toast.error(`Update plan échoué : ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  async function suspend(reason: string) {
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
      toast.error(`Suspend échoué : ${e instanceof Error ? e.message : "?"}`);
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
      toast.error(`Resume échoué : ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  async function softDelete() {
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
      toast.error(`Delete échoué : ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }

  const currentStatus =
    live?.status ??
    (initial.deleted_at ? "deleted" : initial.suspended_at ? "suspended" : "active");
  const currentPlan = live?.plan ?? (initial.plan as NotifusePlan | undefined) ?? "free";

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="text-xs"
        onClick={() => {
          if (!open) refreshStatus();
          setOpen(true);
        }}
        disabled={busy !== null}
      >
        <Mail />
        Notifuse
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Notifuse — {email}</DialogTitle>
            <DialogDescription>
              workspace :{" "}
              <code className="bg-muted px-1 rounded">{initial.workspace_id}</code>
            </DialogDescription>
          </DialogHeader>

          <div className="bg-muted rounded p-2 text-xs space-y-1">
            <div>
              <span className="text-muted-foreground">Status : </span>
              <span
                className={`font-medium ${
                  currentStatus === "active"
                    ? "text-success"
                    : currentStatus === "suspended"
                      ? "text-warning"
                      : "text-destructive"
                }`}
              >
                {currentStatus}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Plan actuel : </span>
              <code className="bg-card px-1 rounded">{currentPlan}</code>
              {initial.plan_source && (
                <span className="text-muted-foreground ml-2">
                  (source : {initial.plan_source})
                </span>
              )}
            </div>
            {live && (
              <div>
                <span className="text-muted-foreground">Quota : </span>
                {live.emails_sent_this_month ?? 0} / {live.monthly_email_quota ?? 0}
                <span className="text-muted-foreground ml-1">
                  (reste {live.quota_remaining ?? 0})
                </span>
              </div>
            )}
            {(live?.suspended_at || initial.suspended_at) && (
              <div className="text-warning">
                Suspendu le {(live?.suspended_at ?? initial.suspended_at)?.slice(0, 19)}
                {(live?.suspended_reason ?? initial.suspended_reason) &&
                  ` — ${live?.suspended_reason ?? initial.suspended_reason}`}
              </div>
            )}
            {(live?.deleted_at || initial.deleted_at) && (
              <div className="text-destructive">
                Soft-deleted le {(live?.deleted_at ?? initial.deleted_at)?.slice(0, 19)}
              </div>
            )}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={refreshStatus}
              disabled={busy !== null}
            >
              {busy === "status" ? "Refresh..." : "↻ Refresh status"}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium">Changer le plan</div>
            <div className="flex gap-2">
              <Select
                value={planDraft}
                onValueChange={(v) => setPlanDraft(v as NotifusePlan)}
              >
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTIFUSE_PLANS.map((p) => (
                    <SelectItem key={p} value={p} className="text-xs">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={planSourceDraft}
                onValueChange={(v) => setPlanSourceDraft(v as PlanSource)}
              >
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_SOURCES.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              type="text"
              value={reasonDraft}
              onChange={(e) => setReasonDraft(e.target.value)}
              placeholder="Raison (optionnel, audit log)"
              className="h-8 text-xs"
            />
            <Button
              type="button"
              size="sm"
              className="w-full text-xs"
              onClick={applyPlan}
              disabled={busy !== null}
            >
              {busy === "plan" ? "Application..." : `Appliquer plan ${planDraft}`}
            </Button>
          </div>

          <div className="flex gap-2 pt-3 border-t border-border">
            {currentStatus === "suspended" ? (
              <Button
                type="button"
                size="sm"
                className="flex-1 text-xs bg-success/15 text-success hover:bg-success/25"
                onClick={resume}
                disabled={busy !== null}
              >
                {busy === "resume" ? "..." : "▶ Resume"}
              </Button>
            ) : currentStatus === "active" ? (
              <Button
                type="button"
                size="sm"
                className="flex-1 text-xs bg-warning/15 text-warning hover:bg-warning/25"
                onClick={() => {
                  setSuspendReason("");
                  setSuspendOpen(true);
                }}
                disabled={busy !== null}
              >
                {busy === "suspend" ? "..." : "⏸ Suspend"}
              </Button>
            ) : null}
            {currentStatus !== "deleted" && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="flex-1 text-xs bg-destructive/15 text-destructive hover:bg-destructive/25"
                onClick={() => setDeleteOpen(true)}
                disabled={busy !== null}
              >
                {busy === "delete" ? "..." : "🗑 Soft-delete"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Suspension — saisie de la raison (ex window.prompt) */}
      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Suspendre {email} ?</DialogTitle>
            <DialogDescription>
              Le workspace Notifuse sera suspendu. La raison est enregistrée
              dans l&apos;audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="notifuse-suspend-reason">Raison</Label>
            <Input
              id="notifuse-suspend-reason"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Raison de la suspension"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSuspendOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!suspendReason.trim()}
              onClick={() => {
                const reason = suspendReason.trim();
                setSuspendOpen(false);
                suspend(reason);
              }}
            >
              Suspendre
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Soft-delete — confirmation (ex window.confirm) */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Soft-delete Notifuse pour {email} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le workspace reste récupérable 30 jours côté Notifuse. Le tenant
              Hub n&apos;est PAS supprimé (utiliser /admin/delete-tenant pour
              ça).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteOpen(false);
                softDelete();
              }}
            >
              Soft-delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

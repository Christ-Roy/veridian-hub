"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Users } from "lucide-react";

import { DashboardPageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

import { NotifuseAdminPanel, type NotifuseSummary } from "./NotifuseAdminPanel";

type TenantServices = {
  prospection?: { provisioned?: boolean; plan?: string | null };
  notifuse?: NotifuseSummary;
};

type Tenant = {
  tenant_id?: string;
  email?: string;
  plan?: string;
  trial_ends_at?: string | null;
  created_at?: string;
  services?: TenantServices;
};

const NOTIFUSE_PLAN_OPTIONS = [
  'free',
  'pro',
  'business',
  'enterprise',
  'lifetime_site_vitrine',
  'lifetime_partner',
  'internal',
] as const;

const PROSPECTION_PLAN_OPTIONS = [
  'freemium',
  'starter',
  'pro',
  'enterprise',
] as const;

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  // Tenant ciblé par le dialog de suppression de trial (null = dialog fermé).
  const [trialToClear, setTrialToClear] = useState<Tenant | null>(null);

  async function fetchTenants() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/list-tenants");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      setTenants(body.tenants ?? body ?? []);
    } catch (e) {
      toast.error(`Chargement échoué : ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTenants();
  }, []);

  async function impersonate(email: string) {
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `status ${res.status}`);
      }
      const data = await res.json();
      toast.success(`Magic links générés pour ${email}`);
      const urls: string[] = [];
      if (data.hub_url) urls.push(data.hub_url);
      if (data.prospection_url) urls.push(data.prospection_url);
      if (data.notifuse_url) urls.push(data.notifuse_url);
      for (const u of urls) window.open(u, "_blank", "noopener");
    } catch (e) {
      toast.error(`Impersonate échoué : ${e instanceof Error ? e.message : "?"}`);
    }
  }

  async function setPlan(
    tenantId: string,
    app: 'notifuse' | 'prospection',
    plan: string,
  ) {
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, plan }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `status ${res.status}`);
      }
      const data = await res.json();
      toast.success(`Plan ${app}=${plan} appliqué`, {
        description: data.warning ?? undefined,
      });
      await fetchTenants();
    } catch (e) {
      toast.error(`Set plan échoué : ${e instanceof Error ? e.message : '?'}`);
    }
  }

  async function setTrial(tenantId: string, value: string | null) {
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // app requis par le validateur — on choisit prospection comme no-op
          // côté apps downstream (DB only). Le seul effet est trialEndsAt.
          app: 'prospection',
          plan: 'freemium',
          trialEndsAt: value,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `status ${res.status}`);
      }
      toast.success(
        value
          ? `Trial étendu jusqu'au ${new Date(value).toLocaleDateString('fr-FR')}`
          : 'Trial supprimé (free pour toujours)',
      );
      await fetchTenants();
    } catch (e) {
      toast.error(`Set trial échoué : ${e instanceof Error ? e.message : '?'}`);
    }
  }

  const filtered = filter
    ? tenants.filter((t) =>
        (t.email ?? "").toLowerCase().includes(filter.toLowerCase())
      )
    : tenants;

  return (
    <div>
      <DashboardPageHeader
        title="Tenants"
        icon={Users}
        description="Plans par app + trial éditable. Source de vérité : DB Hub + propagation Notifuse via HMAC."
        action={
          <Input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer par email..."
            className="w-64"
            aria-label="Filtrer les tenants par email"
          />
        }
        className="mb-6"
      />

      <div className="bg-card rounded-lg border border-border overflow-x-auto">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Plan Prospection</TableHead>
              <TableHead>Plan Notifuse</TableHead>
              <TableHead>Trial expire</TableHead>
              <TableHead>Créé le</TableHead>
              <TableHead>Notifuse</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground py-8"
                >
                  Chargement...
                </TableCell>
              </TableRow>
            )}
            {!loading && filtered.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground py-8"
                >
                  Aucun tenant.
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              filtered.map((t) => {
                const notifusePlan = t.services?.notifuse?.plan ?? 'free';
                const prospectionPlan =
                  t.services?.prospection?.plan ?? 'freemium';
                const notifuseProvisioned = !!t.services?.notifuse?.provisioned;
                const trialValue = t.trial_ends_at
                  ? t.trial_ends_at.slice(0, 10)
                  : '';
                return (
                  <TableRow key={t.tenant_id ?? t.email}>
                    <TableCell className="font-medium">{t.email}</TableCell>

                    <TableCell>
                      <Select
                        value={prospectionPlan}
                        onValueChange={(v) => {
                          if (t.tenant_id) setPlan(t.tenant_id, 'prospection', v);
                        }}
                      >
                        <SelectTrigger className="h-8 w-36 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROSPECTION_PLAN_OPTIONS.map((p) => (
                            <SelectItem key={p} value={p} className="text-xs">
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>

                    <TableCell>
                      <Select
                        value={notifusePlan}
                        onValueChange={(v) => {
                          if (t.tenant_id) setPlan(t.tenant_id, 'notifuse', v);
                        }}
                        disabled={!notifuseProvisioned}
                      >
                        <SelectTrigger
                          className="h-8 w-44 text-xs"
                          title={
                            notifuseProvisioned
                              ? ''
                              : 'Workspace Notifuse non provisionné'
                          }
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {NOTIFUSE_PLAN_OPTIONS.map((p) => (
                            <SelectItem key={p} value={p} className="text-xs">
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>

                    <TableCell className="text-xs">
                      <Input
                        type="date"
                        defaultValue={trialValue}
                        onBlur={(e) => {
                          if (!t.tenant_id) return;
                          const current = trialValue;
                          const next = e.target.value;
                          if (next === current) return;
                          if (next === '') {
                            // Suppression de trial = action sensible →
                            // confirmation via AlertDialog. On remet la valeur
                            // courante en attendant la décision de l'admin ;
                            // le dialog déclenchera setTrial(null) si confirmé.
                            e.target.value = current;
                            setTrialToClear(t);
                          } else {
                            setTrial(t.tenant_id, new Date(next).toISOString());
                          }
                        }}
                        className="h-8 w-36 text-xs"
                        aria-label={`Date de fin de trial pour ${t.email}`}
                      />
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground">
                      {t.created_at
                        ? new Date(t.created_at).toLocaleDateString("fr-FR")
                        : "-"}
                    </TableCell>

                    <TableCell className="relative">
                      {t.tenant_id && t.services?.notifuse ? (
                        <NotifuseAdminPanel
                          tenantId={t.tenant_id}
                          email={t.email ?? ""}
                          initial={t.services.notifuse}
                          onChanged={fetchTenants}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>

                    <TableCell className="text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="text-xs"
                        onClick={() => impersonate(t.email ?? "")}
                      >
                        Impersonate
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </div>

      <AlertDialog
        open={trialToClear !== null}
        onOpenChange={(open) => {
          if (!open) setTrialToClear(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le trial ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le tenant{' '}
              <strong>{trialToClear?.email}</strong> passera en accès gratuit
              sans date de fin (free pour toujours). Tu peux toujours redéfinir
              une date de trial ensuite.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (trialToClear?.tenant_id) {
                  setTrial(trialToClear.tenant_id, null);
                }
                setTrialToClear(null);
              }}
            >
              Supprimer le trial
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

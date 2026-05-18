"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

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

  async function fetchTenants() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/list-tenants");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      setTenants(body.tenants ?? body ?? []);
    } catch (e) {
      toast.error(`Chargement échoué: ${e instanceof Error ? e.message : "?"}`);
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
      toast.error(`Impersonate échoué: ${e instanceof Error ? e.message : "?"}`);
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
      toast.error(`Set plan échoué: ${e instanceof Error ? e.message : '?'}`);
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
      toast.error(`Set trial échoué: ${e instanceof Error ? e.message : '?'}`);
    }
  }

  const filtered = filter
    ? tenants.filter((t) =>
        (t.email ?? "").toLowerCase().includes(filter.toLowerCase())
      )
    : tenants;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Tenants</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Plans par app + trial editable. Source de vérité : DB Hub +
            propagation Notifuse via HMAC.
          </p>
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrer par email..."
          className="px-3 py-2 border rounded-lg text-sm w-64 focus:ring-2 focus:ring-indigo-500 outline-none"
        />
      </div>

      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Email</th>
              <th className="text-left px-4 py-2 font-medium">Plan Prospection</th>
              <th className="text-left px-4 py-2 font-medium">Plan Notifuse</th>
              <th className="text-left px-4 py-2 font-medium">Trial expire</th>
              <th className="text-left px-4 py-2 font-medium">Créé le</th>
              <th className="text-left px-4 py-2 font-medium">Notifuse</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground py-8">
                  Chargement...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground py-8">
                  Aucun tenant.
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((t) => {
                const notifusePlan = t.services?.notifuse?.plan ?? 'free';
                const prospectionPlan = t.services?.prospection?.plan ?? 'freemium';
                const trialValue = t.trial_ends_at
                  ? t.trial_ends_at.slice(0, 10)
                  : '';
                return (
                  <tr key={t.tenant_id ?? t.email} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium">{t.email}</td>

                    <td className="px-4 py-2">
                      <select
                        value={prospectionPlan}
                        onChange={(e) => {
                          if (t.tenant_id) setPlan(t.tenant_id, 'prospection', e.target.value);
                        }}
                        className="text-xs px-2 py-1 rounded border bg-white"
                      >
                        {PROSPECTION_PLAN_OPTIONS.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </td>

                    <td className="px-4 py-2">
                      <select
                        value={notifusePlan}
                        onChange={(e) => {
                          if (t.tenant_id) setPlan(t.tenant_id, 'notifuse', e.target.value);
                        }}
                        disabled={!t.services?.notifuse?.provisioned}
                        className="text-xs px-2 py-1 rounded border bg-white disabled:opacity-50"
                        title={
                          t.services?.notifuse?.provisioned
                            ? ''
                            : 'Workspace Notifuse non provisionné'
                        }
                      >
                        {NOTIFUSE_PLAN_OPTIONS.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </td>

                    <td className="px-4 py-2 text-xs">
                      <input
                        type="date"
                        defaultValue={trialValue}
                        onBlur={(e) => {
                          if (!t.tenant_id) return;
                          const current = trialValue;
                          const next = e.target.value;
                          if (next === current) return;
                          if (next === '') {
                            if (confirm(`Supprimer le trial pour ${t.email} (free pour toujours) ?`)) {
                              setTrial(t.tenant_id, null);
                            } else {
                              e.target.value = current;
                            }
                          } else {
                            setTrial(t.tenant_id, new Date(next).toISOString());
                          }
                        }}
                        className="text-xs px-2 py-1 rounded border w-36"
                      />
                    </td>

                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {t.created_at
                        ? new Date(t.created_at).toLocaleDateString("fr-FR")
                        : "-"}
                    </td>

                    <td className="px-4 py-2 relative">
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
                    </td>

                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => impersonate(t.email ?? "")}
                        className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
                      >
                        Impersonate
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

type Tenant = {
  tenant_id?: string;
  email?: string;
  plan?: string;
  trial_ends_at?: string | null;
  created_at?: string;
  services?: Record<string, { status?: string }>;
  [k: string]: unknown;
};

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
      if (data.twenty_url) urls.push(data.twenty_url);
      if (data.notifuse_url) urls.push(data.notifuse_url);
      for (const u of urls) window.open(u, "_blank", "noopener");
    } catch (e) {
      toast.error(`Impersonate échoué: ${e instanceof Error ? e.message : "?"}`);
    }
  }

  async function grantPlan(email: string, plan: string) {
    try {
      const res = await fetch("/api/admin/grant-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, plan }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `status ${res.status}`);
      }
      toast.success(`Plan ${plan} accordé à ${email}`);
      await fetchTenants();
    } catch (e) {
      toast.error(`Grant plan échoué: ${e instanceof Error ? e.message : "?"}`);
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
            Tous les tenants de la plateforme. Actions: impersonate, grant plan.
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
              <th className="text-left px-4 py-2 font-medium">Plan</th>
              <th className="text-left px-4 py-2 font-medium">Trial</th>
              <th className="text-left px-4 py-2 font-medium">Créé le</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="text-center text-muted-foreground py-8">
                  Chargement...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted-foreground py-8">
                  Aucun tenant.
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((t) => (
                <tr key={t.tenant_id ?? t.email} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{t.email}</td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs">
                      {t.plan ?? "-"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {t.trial_ends_at
                      ? new Date(t.trial_ends_at).toLocaleDateString("fr-FR")
                      : "-"}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {t.created_at
                      ? new Date(t.created_at).toLocaleDateString("fr-FR")
                      : "-"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => impersonate(t.email ?? "")}
                      className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 mr-1"
                    >
                      Impersonate
                    </button>
                    <select
                      onChange={(e) => {
                        if (e.target.value) {
                          grantPlan(t.email ?? "", e.target.value);
                          e.target.value = "";
                        }
                      }}
                      className="text-xs px-2 py-1 rounded border"
                      defaultValue=""
                    >
                      <option value="">Grant plan...</option>
                      <option value="freemium">freemium</option>
                      <option value="starter">starter</option>
                      <option value="pro">pro</option>
                      <option value="enterprise">enterprise</option>
                    </select>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

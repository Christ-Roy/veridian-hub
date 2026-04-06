/**
 * Hub admin — Overview dashboard.
 * Stats globaux sur les tenants, plans, signups récents.
 */
import { createServiceClient } from "@/utils/supabase/server-service";

export default async function AdminOverviewPage() {
  const supabase = createServiceClient();

  // Récupérer tous les tenants
  const { data: tenants } = await supabase.from("tenants").select("*");
  const tenantList = tenants ?? [];

  const total = tenantList.length;
  const byPlan = tenantList.reduce<Record<string, number>>((acc, t) => {
    const plan = (t as { plan?: string }).plan ?? "unknown";
    acc[plan] = (acc[plan] ?? 0) + 1;
    return acc;
  }, {});

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const signupsLastWeek = tenantList.filter((t) => {
    const created = (t as { created_at?: string }).created_at;
    return created && new Date(created).getTime() >= oneWeekAgo;
  }).length;

  const activeTrials = tenantList.filter((t) => {
    const end = (t as { trial_ends_at?: string }).trial_ends_at;
    return end && new Date(end).getTime() > Date.now();
  }).length;

  const cards = [
    { label: "Tenants total", value: total },
    { label: "Signups 7 derniers jours", value: signupsLastWeek },
    { label: "Trials actifs", value: activeTrials },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Overview plateforme</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="bg-white border rounded-lg p-6">
            <div className="text-xs uppercase text-muted-foreground tracking-wide">
              {c.label}
            </div>
            <div className="text-3xl font-bold mt-2">{c.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase mb-4">
          Répartition par plan
        </h2>
        <div className="space-y-2">
          {Object.entries(byPlan)
            .sort(([, a], [, b]) => b - a)
            .map(([plan, count]) => (
              <div key={plan} className="flex items-center justify-between">
                <span className="text-sm font-medium">{plan}</span>
                <span className="text-sm font-mono text-muted-foreground">{count}</span>
              </div>
            ))}
          {Object.keys(byPlan).length === 0 && (
            <div className="text-sm text-muted-foreground">Aucun tenant.</div>
          )}
        </div>
      </div>
    </div>
  );
}

import { redirect } from 'next/navigation';
import { Database } from 'lucide-react';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { getCrmTenantByUserId } from '@/lib/crm/select-tenant';
import { CrmStatusCard, type CrmCardVariant } from './CrmStatusCard';
import { CrmUsageCard, type CrmUsageView } from './CrmUsageCard';

export const metadata = {
  title: 'CRM — Veridian',
  description: 'Gère ton CRM Veridian — workspace, magic-link, quota IA.',
};

export default async function CrmDashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  // Mode plan-agnostic (Q1 pas tranché, revert Robert 2026-05-27) : tout
  // user authentifié peut activer un CRM. La logique d'éligibilité côté
  // Stripe/plan sera ajoutée plus tard quand la grille business sera figée.
  const crmTenant = await getCrmTenantByUserId(userUuid(user));

  const variant: CrmCardVariant = !crmTenant
    ? { kind: 'inactive' }
    : crmTenant.status === 'provisioning'
    ? { kind: 'loading' }
    : { kind: 'active', status: crmTenant.status };

  // Quota IA : mock visuel pour l'instant — la conso réelle et les
  // limites par plan viendront quand le tracker tokens IA sera livré
  // ET quand la grille business sera figée. Affiché uniquement si CRM
  // actif pour ne pas montrer une barre vide à un user sans tenant.
  const usage: CrmUsageView | null =
    variant.kind === 'active'
      ? { used: 0, limit: 1_000_000, mock: true }
      : null;

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="CRM Veridian"
        description="Centralise leads, opportunités et historique relation client."
        icon={Database}
      />
      <div className="grid gap-6">
        <CrmStatusCard variant={variant} />
        {usage && <CrmUsageCard usage={usage} />}
      </div>
    </div>
  );
}

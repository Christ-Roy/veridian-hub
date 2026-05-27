import { redirect } from 'next/navigation';
import { Database } from 'lucide-react';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { PLANS, type PlanKey } from '@/lib/pricing/plans';
import { getCrmTenantByUserId } from '@/lib/crm/select-tenant';
import { CrmStatusCard, type CrmCardVariant } from './CrmStatusCard';
import { CrmUsageCard, type CrmUsageView } from './CrmUsageCard';

// Quotas IA mensuels par plan (figés sprint CRM v1 — cf review ticket).
// Source canonique à terme : `shared/pricing/plans.ts` (champ
// `quotas.crm.tokens_per_month`). En attendant on les hardcode ici pour ne
// pas bloquer l'UI sur le travail submodule.
const CRM_TOKEN_QUOTAS: Partial<Record<PlanKey, number>> = {
  'veridian-pro': 1_500_000,
  'veridian-business': 10_000_000,
};

// Plans qui débloquent l'accès CRM (lecture seule ou complet).
function getCrmAccessLevel(
  planKey: PlanKey | null,
): 'none' | 'readonly' | 'full' {
  if (!planKey) return 'none';
  if (planKey === 'veridian-pro' || planKey === 'lifetime-site-vitrine') {
    return 'readonly';
  }
  if (
    planKey === 'veridian-business' ||
    planKey === 'lifetime-partner' ||
    planKey === 'internal'
  ) {
    return 'full';
  }
  return 'none';
}

export const metadata = {
  title: 'CRM — Veridian',
  description: 'Gère ton CRM Veridian — workspace, magic-link, quota IA.',
};

export default async function CrmDashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const sub = await prisma.subscription
    .findFirst({
      where: {
        userId: userUuid(user),
        status: { in: ['trialing', 'active'] },
      },
      select: { planName: true },
    })
    .catch(() => null);

  const planKey: PlanKey | null =
    sub?.planName && sub.planName in PLANS
      ? (sub.planName as PlanKey)
      : null;
  const planLabel = planKey ? PLANS[planKey].name : 'Free';
  const accessLevel = getCrmAccessLevel(planKey);

  const crmTenant =
    accessLevel === 'none' ? null : await getCrmTenantByUserId(userUuid(user));

  let variant: CrmCardVariant;
  if (accessLevel === 'none') {
    variant = { kind: 'gated' };
  } else if (!crmTenant) {
    variant = { kind: 'inactive', planLabel };
  } else {
    variant = { kind: 'active', planLabel, status: crmTenant.status };
  }

  // Quota IA — uniquement si le user a un CRM actif et un quota défini
  let usage: CrmUsageView | null = null;
  if (variant.kind === 'active' && planKey && CRM_TOKEN_QUOTAS[planKey]) {
    const limit = CRM_TOKEN_QUOTAS[planKey]!;
    // TODO(agent-A/billing): brancher sur la vraie conso mensuelle quand le
    // tracker tokens IA sera livré. En attendant on affiche 0 pour montrer
    // la mécanique sans mentir sur les chiffres.
    const used = 0;
    usage = {
      used,
      limit,
      packCta:
        accessLevel === 'full'
          ? { label: 'Acheter pack +5M tokens (30€)', href: '/dashboard/billing?addon=crm-tokens-5m' }
          : null,
    };
  }

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

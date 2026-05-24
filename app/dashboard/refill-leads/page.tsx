import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { Target } from 'lucide-react';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { RefillLeadsForm } from './RefillLeadsForm';
import { PricingGridInfo } from './PricingGridInfo';
import { EmptyRefillState } from './EmptyRefillState';
import type { ProspectionLocalPlan } from '@/lib/billing/refill-leads';

/**
 * REFILL LEADS — achat de leads supplémentaires Prospection.
 *
 * Flow :
 *  1. Lookup tenant Prospection du user via Prisma (`userId + prospectionProvisionedAt`).
 *  2. Si pas provisionné → EmptyRefillState (CTA vers /dashboard/prospection).
 *  3. Sinon → Card grille tarifaire (info, lecture seule) + Card form (slider qty
 *     + calcul live + submit POST `/api/billing/refill-leads/checkout`).
 *
 * Le calcul du prix est dupliqué côté client (live) pour le feedback UX, mais
 * la source de vérité reste le serveur (le route POST recalcule via la même
 * grille `shared/pricing/refill.ts` avant de créer la session Stripe).
 *
 * Spec : docs/PRICING-VERIDIAN.md §95-108, docs/CONTRAT-BILLING.md §8.4.
 */

const ALLOWED_PROSPECTION_PLANS: readonly ProspectionLocalPlan[] = [
  'freemium',
  'pro',
  'business',
] as const;

export default async function RefillLeadsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const tenant = await prisma.tenant.findFirst({
    where: {
      userId: userUuid(user),
      deletedAt: null,
      prospectionProvisionedAt: { not: null },
    },
    select: {
      id: true,
      prospectionPlan: true,
    },
  });

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="Acheter des leads"
        description="Crédite ton workspace Prospection en leads ciblés. Les leads sont à toi à vie."
        icon={Target}
      />

      {!tenant ? (
        <EmptyRefillState />
      ) : (
        <RefillLeadsContent
          tenantId={tenant.id}
          prospectionPlan={normalizePlan(tenant.prospectionPlan)}
        />
      )}
    </div>
  );
}

function normalizePlan(raw: string | null): ProspectionLocalPlan {
  const lower = (raw ?? 'freemium').toLowerCase();
  return (ALLOWED_PROSPECTION_PLANS as readonly string[]).includes(lower)
    ? (lower as ProspectionLocalPlan)
    : 'freemium';
}

function RefillLeadsContent({
  tenantId,
  prospectionPlan,
}: {
  tenantId: string;
  prospectionPlan: ProspectionLocalPlan;
}) {
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Grille tarifaire — plan {planLabel(prospectionPlan)}</CardTitle>
          <CardDescription>
            Plus tu commandes, moins le lead coûte. Tarif fixe par tranche.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PricingGridInfo plan={prospectionPlan} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Combien de leads veux-tu acheter ?</CardTitle>
          <CardDescription>
            Slider de 1 à 100 000. Tarif unitaire calculé en direct.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RefillLeadsForm tenantId={tenantId} prospectionPlan={prospectionPlan} />
        </CardContent>
      </Card>
    </div>
  );
}

function planLabel(plan: ProspectionLocalPlan): string {
  switch (plan) {
    case 'freemium':
      return 'Free';
    case 'pro':
      return 'Pro';
    case 'business':
      return 'Business';
  }
}

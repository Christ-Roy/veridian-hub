/**
 * Statut d'essai d'un tenant, tel que le Hub l'envoie à chaque app avec le plan (Robert, 08/11 :
 * « il faut toujours savoir les écarts »). Une seule valeur par tenant, toutes apps confondues :
 *
 *   paid          abonnement Stripe actif, ou essai converti
 *   trial_active  essai en cours (machine d'états du Hub, ou essai Stripe), avec sa date de fin
 *   expired       essai fini sans conversion
 *   none          jamais d'essai
 *
 * Les apps STOCKENT ce statut et n'appliquent aucune lecture seule tant que leur drapeau
 * d'application (coupé par défaut) n'est pas levé, ce qui reste une décision de Robert.
 */
import type { PrismaClient } from '@prisma/client';

export const TRIAL_STATUSES = ['none', 'trial_active', 'expired', 'paid'] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

export interface TenantTrialStatus {
  status: TrialStatus;
  endsAt: string | null;
}

type TrialRow = { state: string; trialEndsAt: Date | null };
type SubRow = { status: string; trialEnd: Date | null };

/** Pure : la règle, testée sans base. Un abonnement payé l'emporte sur tout essai. */
export function deriveTrialStatus(trials: TrialRow[], subs: SubRow[]): TenantTrialStatus {
  if (subs.some((s) => s.status === 'active') || trials.some((t) => t.state === 'converted')) {
    return { status: 'paid', endsAt: null };
  }
  const enCours = trials.filter((t) => t.state === 'trial_active' || t.state === 'trial_ending_soon');
  const stripeTrial = subs.filter((s) => s.status === 'trialing');
  if (enCours.length || stripeTrial.length) {
    const fins = [...enCours.map((t) => t.trialEndsAt), ...stripeTrial.map((s) => s.trialEnd)]
      .filter((d): d is Date => d instanceof Date)
      .map((d) => d.getTime());
    return { status: 'trial_active', endsAt: fins.length ? new Date(Math.max(...fins)).toISOString() : null };
  }
  if (trials.some((t) => t.state === 'expired')) return { status: 'expired', endsAt: null };
  return { status: 'none', endsAt: null };
}

type TrialDb = Pick<PrismaClient, 'tenant' | 'tenantTrial' | 'subscription'>;

export async function trialStatusForTenant(db: TrialDb, tenantId: string): Promise<TenantTrialStatus> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { userId: true } });
  if (!tenant) return { status: 'none', endsAt: null };
  const [trials, subs] = await Promise.all([
    db.tenantTrial.findMany({ where: { tenantId }, select: { state: true, trialEndsAt: true } }),
    db.subscription.findMany({ where: { userId: tenant.userId }, select: { status: true, trialEnd: true } }),
  ]);
  return deriveTrialStatus(trials, subs as SubRow[]);
}

/** Lot : un statut par tenant en deux requêtes (reconcile parcourt tous les tenants). */
export async function trialStatusesForTenants(
  db: Pick<PrismaClient, 'tenantTrial' | 'subscription'>,
  tenants: Array<{ id: string; userId: string }>,
): Promise<Map<string, TenantTrialStatus>> {
  const [trials, subs] = await Promise.all([
    db.tenantTrial.findMany({
      where: { tenantId: { in: tenants.map((t) => t.id) } },
      select: { tenantId: true, state: true, trialEndsAt: true },
    }),
    db.subscription.findMany({
      where: { userId: { in: Array.from(new Set(tenants.map((t) => t.userId))) } },
      select: { userId: true, status: true, trialEnd: true },
    }),
  ]);
  const out = new Map<string, TenantTrialStatus>();
  for (const t of tenants) {
    out.set(
      t.id,
      deriveTrialStatus(
        trials.filter((r) => r.tenantId === t.id),
        (subs as Array<SubRow & { userId: string }>).filter((s) => s.userId === t.userId),
      ),
    );
  }
  return out;
}

/** Abonnement d'une source d'événements : le secret Standard Webhooks est chiffré au repos (coffre), lu le temps d'une vérification, jamais journalisé. */
import type { PrismaClient } from '@prisma/client';

import { chiffrer, dechiffrer } from '@/lib/ia/coffre';

type Db = Pick<PrismaClient, 'evenementAbonnement'>;

export async function poserAbonnement(db: Db, d: { tenantId: string; source: string; cleExterne: string; secret: string }, env?: NodeJS.ProcessEnv): Promise<void> {
  const secretChiffre = chiffrer(d.secret, env);
  await db.evenementAbonnement.upsert({ where: { source_cleExterne: { source: d.source, cleExterne: d.cleExterne } }, create: { tenantId: d.tenantId, source: d.source, cleExterne: d.cleExterne, secretChiffre }, update: { tenantId: d.tenantId, secretChiffre } });
}

/** `null` si aucun abonnement : l'appelant répond comme pour une mauvaise signature, on ne dit pas quels espaces existent. */
export async function lireAbonnement(db: Db, source: string, cleExterne: string, env?: NodeJS.ProcessEnv): Promise<{ tenantId: string; secret: string } | null> {
  const a = await db.evenementAbonnement.findUnique({ where: { source_cleExterne: { source, cleExterne } } });
  return a ? { tenantId: a.tenantId, secret: dechiffrer(a.secretChiffre, env) } : null;
}

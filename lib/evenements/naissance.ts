/**
 * Une organisation NEUVE, quand Mail et le CRM y sont tous deux ouverts, reçoit l'événement « Mail vers CRM » par défaut (lib/delegation/etat.ts) : il lui
 * faut son abonnement chez Mail. Appelé après l'ouverture d'une app, sans jamais la faire échouer ; rejouable, une organisation abonnée ou réglée n'est pas touchée.
 */
import type { PrismaClient } from '@prisma/client';

import { contexteDe, etatDe } from '@/lib/delegation/etat';
import { organisationDeTest } from '@/lib/delegation/ouverture';
import { evenementOuvert, paire } from '@/lib/delegation/paires';

import { suivreAbonnement } from './allumage';

type Db = Pick<PrismaClient, 'tenant' | 'organisation' | 'integrationPaire' | 'evenementAbonnement'>;

export async function abonnerParDefaut(db: Db, tenantId: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<'sans_objet' | 'fait' | 'echec'> {
  try {
    const p = paire('notifuse>crm')!;
    if (!evenementOuvert(p.cle, tenantId, env, await organisationDeTest(db, tenantId, env))) return 'sans_objet';
    const l = await db.integrationPaire.findUnique({ where: { tenantId_paire: { tenantId, paire: p.cle } } });
    if (!etatDe(p, l, await contexteDe(db, tenantId), true).parDefaut) return 'sans_objet';
    if (await db.evenementAbonnement.findFirst({ where: { tenantId, source: 'notifuse' }, select: { tenantId: true } })) return 'sans_objet';
    const r = await suivreAbonnement(db, { tenantId, paire: p.cle, actif: true }, env, fetchImpl);
    if (r === 'echec') console.error(JSON.stringify({ tag: '[evenements]', level: 'error', msg: 'abonnement par défaut impossible', tenant_id: tenantId }));
    return r;
  } catch (err) {
    console.error(JSON.stringify({ tag: '[evenements]', level: 'error', msg: 'abonnement par défaut', tenant_id: tenantId, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
    return 'echec';
  }
}

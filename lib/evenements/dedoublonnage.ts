/**
 * Dédoublonnage en base d'un événement reçu : par (source, id de livraison, stable entre les réessais), par message_id et par Message-ID RFC
 * (deux boîtes qui rangent le même mail font deux livraisons). Une ligne `pris` morte (processus tombé) se reprend après 3 min ; un échec libère la ligne,
 * pour que la source puisse réessayer.
 */
import type { PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'evenementRecu'>;
export type CleEvenement = { source: string; evenementId: string; messageId: string; cleRfc: string | null; tenantId: string };
const REPRISE_MS = 3 * 60_000;
const CONSERVATION_MS = 30 * 86_400_000;

export async function reserver(db: Db, c: CleEvenement, now = Date.now()): Promise<'neuf' | 'deja' | 'en_cours'> {
  try {
    await db.evenementRecu.create({ data: { ...c, prisLe: new Date(now) } });
    return 'neuf';
  } catch (err) {
    const l = await db.evenementRecu.findFirst({ where: { source: c.source, OR: [{ evenementId: c.evenementId }, { messageId: c.messageId }, ...(c.cleRfc ? [{ cleRfc: c.cleRfc }] : [])] } });
    if (!l) throw err;
    if (l.etat !== 'pris') return 'deja';
    const repris = await db.evenementRecu.updateMany({ where: { id: l.id, etat: 'pris', prisLe: { lt: new Date(now - REPRISE_MS) } }, data: { prisLe: new Date(now) } });
    return repris.count === 1 ? 'neuf' : 'en_cours';
  }
}

export async function terminer(db: Db, c: CleEvenement, etat: 'fait' | 'ignore', raison?: string, now = Date.now()): Promise<void> {
  await db.evenementRecu.updateMany({ where: { source: c.source, messageId: c.messageId }, data: { etat, raison: raison ?? null, termineLe: new Date(now) } });
  // Pas de tâche planifiée : le nettoyage se fait à l'usage.
  await db.evenementRecu.deleteMany({ where: { prisLe: { lt: new Date(now - CONSERVATION_MS) } } }).catch(() => undefined);
}

export async function liberer(db: Db, c: CleEvenement): Promise<void> {
  await db.evenementRecu.deleteMany({ where: { source: c.source, messageId: c.messageId, etat: 'pris' } });
}

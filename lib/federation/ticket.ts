/**
 * Ticket à usage unique entre le retour du fournisseur et Auth.js (VER-227 S2, D1) : 60 s, seule l'empreinte est gardée. La session, la révocation
 * et la 2FA restent UN seul système : le fournisseur interne `federation` ne fait que rendre la personne que le ticket désigne.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

export const FOURNISSEUR_FEDERATION = 'federation';
const TICKET_MS = 60_000;

type Db = Pick<PrismaClient, 'federationTicket'>;
const empreinte = (t: string): string => createHash('sha256').update(`ticket:${t}`).digest('hex');

export async function emettreTicket(db: Db, userId: string, tenantId: string, now = Date.now()): Promise<string> {
  const t = randomBytes(32).toString('base64url');
  await db.federationTicket.deleteMany({ where: { expireLe: { lt: new Date(now) } } });
  await db.federationTicket.create({ data: { empreinte: empreinte(t), userId, tenantId, expireLe: new Date(now + TICKET_MS) } });
  return t;
}

/** Une seule fois : la suppression est l'acte, deux lectures simultanées n'en gagnent qu'une. */
export async function consommerTicket(db: Db, ticket: unknown, now = Date.now()): Promise<{ userId: string; tenantId: string } | null> {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const l = await db.federationTicket.findUnique({ where: { empreinte: empreinte(ticket) }, select: { userId: true, tenantId: true, expireLe: true } });
  if (!l) return null;
  const pris = await db.federationTicket.deleteMany({ where: { empreinte: empreinte(ticket) } });
  return pris.count === 1 && l.tenantId && l.expireLe.getTime() > now ? { userId: l.userId, tenantId: l.tenantId } : null;
}

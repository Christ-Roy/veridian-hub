/**
 * Première entrée par le fournisseur d'une organisation qui n'affirme aucune adresse (VER-261). Son identifiant (fournisseur, `sub`) est inconnu de nous :
 * la personne prouve une adresse que l'organisation ATTEND (membre, ou pré-inscrite) par un code reçu, et l'identifiant lui est lié pour de bon. Rien n'est
 * rattaché sur une adresse dite, ni par le fournisseur ni par elle. La réponse à une adresse attendue ou non est la même.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { codesParAdresse, titulaireSecondaire } from '@/lib/adresses';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { applyProviderEmailProof } from '@/lib/auth/email-proof-provider';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { sendMail } from '@/lib/email/send';
import { renderPremiereEntreeEmail } from '@/lib/email/templates/premiere-entree';
import { chiffrer, dechiffrer } from '@/lib/ia/coffre';
import { isTestAccount } from '@/lib/sync/test-residue';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';

import { entrer, fournisseur, relier, type DbIdentite, type RefusFederation } from './identite';
import type { IdpPret } from './idp';

export const COOKIE_PREMIERE = 'veridian-premiere-entree';
export const PREMIERE_S = 15 * 60;
export const CODE_PREMIERE_MIN = 10;
export const essaisPremiere = new RateLimiter({ capacity: 5, windowMs: CODE_PREMIERE_MIN * 60_000, name: 'premiere-essais' });
export const codesPremiere = new RateLimiter({ capacity: 5, windowMs: 60 * 60_000, name: 'premiere-codes' });

const Scelle = z.object({ t: z.literal('premiere'), idp: z.string(), sub: z.string().min(1).max(255), exp: z.number() });
export type Premiere = { idp: string; sub: string };
export const scellerPremiere = (p: Premiere, now = Date.now()): string => chiffrer(JSON.stringify({ t: 'premiere', ...p, exp: Math.floor(now / 1000) + PREMIERE_S }));
export function ouvrirPremiere(scelle: string | undefined, now = Date.now()): Premiere | null {
  if (!scelle) return null;
  try {
    const x = Scelle.parse(JSON.parse(dechiffrer(scelle)));
    return x.exp * 1000 > now ? { idp: x.idp, sub: x.sub } : null;
  } catch {
    return null;
  }
}

type Db = DbIdentite & Pick<PrismaClient, 'verificationToken'>;
const cle = (p: Premiere): string => `${p.idp}:${p.sub}`;
const empreinte = (p: Premiere, email: string, code: string, env: NodeJS.ProcessEnv = process.env): string => {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET absent');
  return createHmac('sha256', env.AUTH_SECRET).update(`premiere:${cle(p)}:${email}:${code}`).digest('hex');
};
const identifiant = (p: Premiere, email: string): string => `premiere:${createHmac('sha256', process.env.AUTH_SECRET ?? '').update(`${cle(p)}:${email}`).digest('hex')}`;

type Attendue = { userId: string; hubUserId: string; prouvee: boolean; secondaire: boolean } | { neuf: true };
/** Qui l'organisation attend sous cette adresse : un compte membre, ou une pré-inscription vivante. Null : personne. */
async function attendue(db: Db, i: IdpPret, email: string): Promise<Attendue | null> {
  // Une organisation de test n'ouvre qu'aux comptes de batterie.
  if (i.test && !isTestAccount(email)) return null;
  const secondaire = await titulaireSecondaire(db, email);
  const u = await db.user.findUnique({ where: secondaire ? { id: secondaire } : { email }, select: { id: true, supabaseUserId: true, emailVerified: true } });
  const inscrite = (await db.tenantPreinscription.count({ where: { tenantId: i.tenantId, email, consommeeLe: null, annuleeLe: null, expireLe: { gt: new Date() } } })) > 0;
  if (!u) return inscrite ? { neuf: true } : null;
  if (!u.supabaseUserId) return null;
  const t = await db.tenant.findFirst({ where: { id: i.tenantId, deletedAt: null }, select: { userId: true } });
  const membre = t?.userId === u.supabaseUserId || (await db.tenantMember.findFirst({ where: { tenantId: i.tenantId, userId: u.supabaseUserId, deletedAt: null }, select: { tenantId: true } })) !== null;
  return membre || inscrite ? { userId: u.id, hubUserId: u.supabaseUserId, prouvee: Boolean(u.emailVerified) || Boolean(secondaire), secondaire: Boolean(secondaire) } : null;
}

/** Même réponse que l'adresse soit attendue ou non. `trop` : le débit, seul refus visible. */
export async function demanderPremiere(db: Db, i: IdpPret, p: Premiere, brut: string, send: typeof sendMail = sendMail, now = new Date()): Promise<'demande' | 'trop'> {
  const email = normaliserEmail(brut);
  if (!(await codesPremiere.enforce(cle(p))).ok) return 'trop';
  if (!(await attendue(db, i, email)) || !(await codesParAdresse.enforce(email)).ok) return 'demande';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.verificationToken.deleteMany({ where: { identifier: identifiant(p, email) } });
  await db.verificationToken.create({ data: { identifier: identifiant(p, email), token: empreinte(p, email, code), expires: new Date(now.getTime() + CODE_PREMIERE_MIN * 60_000) } });
  await send({ to: email, ...renderPremiereEntreeEmail({ code, minutes: CODE_PREMIERE_MIN }) });
  return 'demande';
}

/** Le code est juste : l'identifiant est lié pour de bon, et elle entre. Tout est relu ici. */
export async function confirmerPremiere(db: Db, i: IdpPret, p: Premiere, brut: string, code: string, now = new Date()): Promise<{ userId: string; hubUserId: string; neuf: boolean } | { refus: RefusFederation | 'code_faux' | 'trop' }> {
  const email = normaliserEmail(brut);
  if (!(await essaisPremiere.enforce(cle(p))).ok) return { refus: 'trop' };
  const l = await db.verificationToken.findFirst({ where: { identifier: identifiant(p, email), expires: { gt: now } }, select: { token: true, identifier: true } });
  const attendu = Buffer.from(empreinte(p, email, /^\d{6}$/.test(code) ? code : 'x'));
  const garde = Buffer.from(l?.token ?? ''.padEnd(attendu.length, '0'));
  if (!l || garde.length !== attendu.length || !timingSafeEqual(garde, attendu)) return { refus: 'code_faux' };
  // Une seule fois : la suppression est l'acte.
  if ((await db.verificationToken.deleteMany({ where: { token: l.token, identifier: l.identifier } })).count !== 1) return { refus: 'code_faux' };
  const provider = fournisseur(i);
  if (await db.account.findUnique({ where: { provider_providerAccountId: { provider, providerAccountId: p.sub } }, select: { userId: true } })) return { refus: 'autre_identite' };
  const a = await attendue(db, i, email);
  if (!a) return { refus: 'non_attendu' };
  if ('neuf' in a) {
    const hubUserId = randomUUID();
    const u = await db.user.create({ data: { email, emailVerified: now, supabaseUserId: hubUserId }, select: { id: true } });
    await relier(db, i, u.id, p.sub);
    await provisionDefaultWorkspace({ userId: u.id, email, name: null }, { prisma: db as unknown as PrismaClient, actor: 'system:federation' }).catch((err) => console.error('[federation] workspace', err instanceof Error ? err.message.slice(0, 160) : 'erreur'));
    return entrer(db, i, { userId: u.id, hubUserId, neuf: true }, {});
  }
  if (await db.account.findFirst({ where: { userId: a.userId, provider }, select: { id: true } })) return { refus: 'autre_identite' };
  // Jamais prouvée : ce code est la PREMIÈRE preuve. Ce qui avait été posé avant (mot de passe, liens, sessions) tombe (M2).
  if (!a.prouvee) await applyProviderEmailProof(db as never, a.userId, provider, { providerAccountId: p.sub, sessions: 'toujours' });
  await relier(db, i, a.userId, p.sub);
  return entrer(db, i, { userId: a.userId, hubUserId: a.hubUserId, neuf: false }, {});
}

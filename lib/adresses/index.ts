/**
 * Plusieurs adresses par personne (VER-227 S1b, SSO-ORGANISATIONS §10). L'identité est le compte ; une adresse est un attribut qu'on PROUVE par un
 * code reçu. Une adresse secondaire n'ouvre pas de session et ne reçoit aucun lien : elle sert à être reconnu (pré-inscription, fédération). La
 * principale reste `users.email`. Une adresse active n'appartient qu'à une personne : la base le tient (migration 20261125040000), pas ce fichier.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { sendMail } from '@/lib/email/send';
import { renderAdresseCodeEmail } from '@/lib/email/templates/adresse-code';

import { annulationOuverte } from './annulation';

export const CODE_MIN = 10;
export const ESSAIS_MAX = 5;
export const ADRESSES_MAX = 5;
/** Par compte, et par adresse visée quelle que soit l'IP : pas de bombardement d'une boîte. */
export const codesParCompte = new RateLimiter({ capacity: 5, windowMs: 60 * 60_000, name: 'adresse-compte' });
export const codesParAdresse = new RateLimiter({ capacity: 4, windowMs: 60 * 60_000, name: 'adresse-adresse' });

type Db = Pick<PrismaClient, 'user' | 'userEmail' | 'userEmailCode' | 'auditLog'>;
export type Personne = { id: string; email: string };
const empreinte = (userId: string, email: string, code: string, env: NodeJS.ProcessEnv = process.env): string => {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET absent');
  return createHmac('sha256', env.AUTH_SECRET).update(`adresse:${userId}:${email}:${code}`).digest('hex');
};

/** La personne dont c'est une adresse secondaire active, ou null. */
export async function titulaireSecondaire(db: Pick<PrismaClient, 'userEmail'>, email: string): Promise<string | null> {
  return (await db.userEmail.findFirst({ where: { email: normaliserEmail(email), detacheeLe: null }, select: { userId: true } }))?.userId ?? null;
}

/** Ses adresses PROUVÉES : la principale si elle l'est, puis les secondaires actives. */
export async function adressesProuvees(db: Pick<PrismaClient, 'userEmail'>, u: { id: string; email: string; emailVerified: Date | null }): Promise<string[]> {
  const l = await db.userEmail.findMany({ where: { userId: u.id, detacheeLe: null }, select: { email: true }, orderBy: { prouveeLe: 'asc' } });
  return [...(u.emailVerified ? [normaliserEmail(u.email)] : []), ...l.map((x) => x.email)];
}

/**
 * Demande un code. La réponse est la MÊME que l'adresse soit libre, prise, ou déjà à elle : rien ne dit si une adresse existe chez nous (M8). Prise,
 * aucun mail ne part. `trop` : le débit, seul refus visible.
 */
export async function demanderCode(db: Db, u: Personne, brut: string, send: typeof sendMail = sendMail, now = new Date()): Promise<'demande' | 'trop'> {
  const email = normaliserEmail(brut);
  if (!codesParCompte.enforce(u.id).ok) return 'trop';
  const [principale, titulaire, siennes] = await Promise.all([
    db.user.findUnique({ where: { email }, select: { id: true } }),
    titulaireSecondaire(db, email),
    db.userEmail.count({ where: { userId: u.id, detacheeLe: null } }),
  ]);
  if (principale || titulaire || siennes >= ADRESSES_MAX || !codesParAdresse.enforce(email).ok) return 'demande';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const ligne = { email, codeEmpreinte: empreinte(u.id, email, code), essais: 0, expireLe: new Date(now.getTime() + CODE_MIN * 60_000) };
  await db.userEmailCode.upsert({ where: { userId: u.id }, create: { userId: u.id, ...ligne }, update: ligne });
  await send({ to: email, ...renderAdresseCodeEmail({ code, minutes: CODE_MIN }) });
  return 'demande';
}

/** Cinq essais par code ; l'essai est compté AVANT la comparaison, deux requêtes simultanées n'en gagnent pas. Prise entre-temps : refus, jamais volée. */
export async function confirmerCode(db: Db, u: Personne, brut: string, code: string, now = new Date()): Promise<'ajoutee' | 'code_invalide' | 'prise'> {
  const email = normaliserEmail(brut);
  if (!/^\d{6}$/.test(code)) return 'code_invalide';
  const essai = await db.userEmailCode.updateMany({ where: { userId: u.id, email, expireLe: { gt: now }, essais: { lt: ESSAIS_MAX } }, data: { essais: { increment: 1 } } });
  if (essai.count !== 1) return 'code_invalide';
  const l = await db.userEmailCode.findUnique({ where: { userId: u.id }, select: { codeEmpreinte: true, email: true } });
  if (!l || l.email !== email || !timingSafeEqual(Buffer.from(l.codeEmpreinte, 'hex'), Buffer.from(empreinte(u.id, email, code), 'hex'))) return 'code_invalide';
  const consomme = await db.userEmailCode.deleteMany({ where: { userId: u.id, codeEmpreinte: l.codeEmpreinte } });
  if (consomme.count !== 1) return 'code_invalide';
  try {
    await db.userEmail.create({ data: { userId: u.id, email, preuve: 'code', prouveeLe: now } });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    return 'prise';
  }
  // Ni l'adresse ni son empreinte au journal : le compte et le geste.
  await writeAuditLog(db as PrismaClient, { action: 'adresse.ajoutee', actor: `user:${u.id}`, targetType: 'user', targetId: u.id });
  return 'ajoutee';
}

/** La principale ne se détache pas : elle n'est pas ici. La ligne reste, datée. */
export async function detacher(db: Db & Pick<PrismaClient, 'verificationToken'>, u: Personne, brut: string, now = new Date()): Promise<boolean | 'annulation_ouverte'> {
  const l = await db.userEmail.findFirst({ where: { userId: u.id, email: normaliserEmail(brut), detacheeLe: null }, select: { id: true } });
  // L'ancienne principale garde 72 h pour annuler : la détacher fermerait la sortie de secours de qui on a pris la session.
  if (l && (await annulationOuverte(db, u.id, l.id, now))) return 'annulation_ouverte';
  const { count } = await db.userEmail.updateMany({ where: { userId: u.id, email: normaliserEmail(brut), detacheeLe: null }, data: { detacheeLe: now, detacheePar: 'user' } });
  if (count) await writeAuditLog(db as PrismaClient, { action: 'adresse.detachee', actor: `user:${u.id}`, targetType: 'user', targetId: u.id });
  return count > 0;
}

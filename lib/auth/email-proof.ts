/**
 * Preuve d'adresse email : aucune session d'app sans adresse prouvée.
 *
 * Le Hub transmet l'email aux apps, et une app peut retrouver son compte par cet
 * email. Sans preuve, créer un compte Hub au nom de quelqu'un ouvrirait donc son
 * compte d'app (mesuré en prod le 06/11/2026 sur `regenerate-login` et
 * `tenants/start`). Toute route qui mène à une session d'app appelle
 * `denyUnlessEmailProven`. Un test statique le vérifie
 * (`__tests__/lib/auth/email-proof-routes.test.ts`).
 *
 * Trois preuves :
 *  - le fournisseur OAuth certifie l'adresse (`email-proof-provider.ts`) ;
 *  - le lien reçu par mail, cliqué DANS une session de ce compte
 *    (`consumeEmailProof`) ;
 *  - une invitation envoyée à cette adresse.
 *
 * Pourquoi le lien exige la session du compte : un scanner de mail qui suit les
 * liens, ou une victime qui clique sans comprendre, ne doit pas valider le compte
 * d'un usurpateur. Elle n'a pas son mot de passe, donc le lien ne fait rien pour elle.
 *
 * Pourquoi une preuve OAuth annule le mot de passe : il a pu être posé à l'avance
 * par quelqu'un d'autre (pré-détournement de compte). Les sessions étant des JWT de
 * 90 jours, on invalide aussi celles déjà émises (`sessionsValidAfter`).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { sendMail } from '@/lib/email/send';
import { renderEmailProofEmail } from '@/lib/email/templates/email-proof';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { getURL } from '@/utils/helpers';

export { applyProviderEmailProof, providerProvesEmail } from '@/lib/auth/email-proof-provider';

export const EMAIL_PROOF_IDENTIFIER_PREFIX = 'email-proof:';
export const EMAIL_PROOF_TTL_HOURS = 48;
/** Un seul mail par compte sur cette fenêtre : pas de bombardement d'une boîte. */
const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

type ProofPrisma = Pick<PrismaClient, 'user' | 'verificationToken'>;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Préfixe des jetons d'un compte, toutes adresses confondues. Les jetons d'une ancienne
 * adresse se retrouvent par ce préfixe, pour être supprimés au renvoi.
 */
function userProofPrefix(userId: string): string {
  return `${EMAIL_PROOF_IDENTIFIER_PREFIX}${userId}:`;
}

/**
 * Identifiant d'un jeton : le compte ET l'adresse à prouver. Un jeton émis pour `a@evil`
 * ne prouve donc plus rien une fois l'adresse du compte changée (D2). L'empreinte évite
 * d'écrire l'adresse en clair dans la table.
 */
function proofIdentifier(userId: string, email: string): string {
  return `${userProofPrefix(userId)}${hashToken(email.trim().toLowerCase())}`;
}

/**
 * Envoie le lien de preuve. Renvoie `false` si un lien récent existe déjà : le
 * client n'a rien de plus à faire que lire le mail déjà parti.
 */
export async function issueEmailProof(
  prisma: ProofPrisma,
  user: { id: string; email: string },
  send: typeof sendMail = sendMail,
): Promise<boolean> {
  const identifier = proofIdentifier(user.id, user.email);
  const ttlMs = EMAIL_PROOF_TTL_HOURS * 60 * 60 * 1000;
  const recent = await prisma.verificationToken.findFirst({
    where: { identifier, expires: { gt: new Date(Date.now() + ttlMs - RESEND_COOLDOWN_MS) } },
    select: { token: true },
  });
  if (recent) return false;

  // Un seul jeton vivant par compte : celui de l'adresse courante remplace aussi ceux
  // des adresses précédentes.
  await prisma.verificationToken.deleteMany({
    where: { identifier: { startsWith: userProofPrefix(user.id) } },
  });
  const token = randomBytes(32).toString('base64url');
  await prisma.verificationToken.create({
    data: { identifier, token: hashToken(token), expires: new Date(Date.now() + ttlMs) },
  });

  const confirmUrl = `${getURL()}/auth/email-proof?token=${encodeURIComponent(token)}`;
  const { subject, html, text } = renderEmailProofEmail({
    confirmUrl,
    expiresInHours: EMAIL_PROOF_TTL_HOURS,
  });
  await send({ to: user.email, subject, html, text });
  return true;
}

export type ConsumeEmailProofResult = 'proved' | 'invalid' | 'wrong_account';

/** Consomme le lien, uniquement pour le compte de la session qui le présente. */
export async function consumeEmailProof(
  prisma: ProofPrisma,
  token: string,
  sessionUserId: string,
): Promise<ConsumeEmailProofResult> {
  const row = await prisma.verificationToken.findUnique({
    where: { token: hashToken(token) },
    select: { identifier: true, expires: true },
  });
  if (!row || !row.identifier.startsWith(EMAIL_PROOF_IDENTIFIER_PREFIX)) return 'invalid';
  if (row.expires.getTime() <= Date.now()) return 'invalid';
  if (!row.identifier.startsWith(userProofPrefix(sessionUserId))) {
    return 'wrong_account';
  }
  // Jeton d'une adresse que le compte n'a plus : périmé, même s'il est encore en base.
  const current = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { email: true },
  });
  if (!current?.email || row.identifier !== proofIdentifier(sessionUserId, current.email)) {
    return 'invalid';
  }
  await prisma.verificationToken.deleteMany({ where: { identifier: row.identifier } });
  await prisma.user.update({
    where: { id: sessionUserId },
    data: { emailVerified: new Date() },
  });
  return 'proved';
}

/**
 * Lecture seule : cette session peut-elle ouvrir une app ? L'impersonation admin
 * reste permise : elle est tracée, et n'envoie aucun mail au client.
 */
export async function isEmailProvenForSession(userId: string): Promise<boolean> {
  const session = await auth();
  if (session?.user?.impersonated === true) return true;
  const row = await defaultPrisma.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true },
  });
  return Boolean(row?.emailVerified);
}

/**
 * Garde des routes qui mènent à une session d'app. Renvoie la réponse de refus, ou
 * `null` si l'accès est permis. Le refus déclenche l'envoi automatique du lien : le
 * client lit son mail, confirme, et continue. Un échec d'envoi ne lève jamais le refus.
 */
export async function denyUnlessEmailProven(user: {
  id: string;
  email: string;
}): Promise<NextResponse | null> {
  if (await isEmailProvenForSession(user.id)) return null;

  let sent = false;
  try {
    await issueEmailProof(defaultPrisma, user);
    sent = true;
  } catch (err) {
    console.error('[email-proof] envoi du lien impossible', err);
  }
  return NextResponse.json(
    {
      error: 'email_not_verified',
      message: sent
        ? `Confirmez votre adresse pour ouvrir cet outil : le lien est dans votre boîte ${user.email}.`
        : `Confirmez votre adresse pour ouvrir cet outil. L'envoi du lien a échoué, réessayez dans un instant.`,
    },
    { status: 403 },
  );
}

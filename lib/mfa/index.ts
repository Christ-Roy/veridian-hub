// Lib 2FA email opt-in pour le Hub.
//
// Responsabilités :
// - Générer un code 6 chiffres cryptographiquement sûr
// - Le hasher (bcrypt) et le stocker dans mfa_codes avec TTL 10 minutes
// - Vérifier un code en comparaison constant-time (via bcrypt.compare)
// - Envoyer le code au mail du user via Brevo / SMTP
//
// Politique :
// - Un seul code valide à la fois par user : les codes actifs non consommés
//   sont invalidés quand on en génère un nouveau (on les marque consumedAt)
// - Rate limiting applicatif minimal : max 5 codes générés par user par heure

import bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';

import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/email/send';
import { renderMfaCodeEmail } from '@/lib/email/templates/mfa-code';

export const MFA_CODE_LENGTH = 6;
export const MFA_CODE_TTL_MINUTES = 10;
export const MFA_MAX_CODES_PER_HOUR = 5;

export class MfaRateLimitError extends Error {
  constructor() {
    super('Trop de codes 2FA demandés. Réessaye dans une heure.');
    this.name = 'MfaRateLimitError';
  }
}

/**
 * Génère un code 6 chiffres cryptographiquement sûr.
 * `randomInt` (crypto) est uniforme contrairement à Math.random().
 */
export function generateRandomCode(length = MFA_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += randomInt(0, 10).toString();
  }
  return out;
}

/**
 * Crée un nouveau code MFA pour un user, invalide les anciens, retourne
 * le code en clair (à envoyer par mail — JAMAIS à retourner dans une API
 * publique).
 */
export async function issueMfaCode(userId: string): Promise<string> {
  // Rate limit : compter les codes émis dans la dernière heure
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await prisma.mfaCode.count({
    where: {
      userId,
      createdAt: { gte: oneHourAgo },
    },
  });

  if (recentCount >= MFA_MAX_CODES_PER_HOUR) {
    throw new MfaRateLimitError();
  }

  // Invalider tous les codes non consommés précédents
  await prisma.mfaCode.updateMany({
    where: {
      userId,
      consumedAt: null,
    },
    data: {
      consumedAt: new Date(),
    },
  });

  const code = generateRandomCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + MFA_CODE_TTL_MINUTES * 60 * 1000);

  await prisma.mfaCode.create({
    data: {
      userId,
      codeHash,
      expiresAt,
    },
  });

  return code;
}

/**
 * Vérifie un code MFA en clair contre les codes actifs du user.
 * Retourne true si un match est trouvé ET le marque consumedAt.
 * Comparaison constant-time via bcrypt.compare.
 */
export async function verifyMfaCode(userId: string, code: string): Promise<boolean> {
  if (!/^\d+$/.test(code) || code.length !== MFA_CODE_LENGTH) {
    return false;
  }

  const candidates = await prisma.mfaCode.findMany({
    where: {
      userId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  for (const candidate of candidates) {
    const match = await bcrypt.compare(code, candidate.codeHash);
    if (match) {
      await prisma.mfaCode.update({
        where: { id: candidate.id },
        data: { consumedAt: new Date() },
      });
      return true;
    }
  }

  return false;
}

/**
 * Envoie le code MFA par email. Wrap l'envoi dans un try/catch géré à l'étage
 * au-dessus si besoin (le caller peut vouloir logger l'échec sans bloquer).
 */
export async function sendMfaCodeEmail(to: string, code: string): Promise<void> {
  const { subject, html, text } = renderMfaCodeEmail({
    code,
    expiresInMinutes: MFA_CODE_TTL_MINUTES,
  });
  await sendMail({ to, subject, html, text });
}

/**
 * Helper high-level : génère un code, l'envoie par mail, retourne void.
 * Utilisé par les callbacks Auth.js et le handler /api/auth/mfa/resend.
 */
export async function issueAndSendMfaCode(user: { id: string; email: string }): Promise<void> {
  const code = await issueMfaCode(user.id);
  await sendMfaCodeEmail(user.email, code);
}

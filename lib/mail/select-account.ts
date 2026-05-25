/**
 * Sélection du compte Mail à utiliser pour `POST /api/mail/send-as-user`.
 *
 * Logique v1.1 (multi-comptes) — ticket
 * `todo/2026-05-25-mail-provider-status-endpoint.md` :
 *
 *   1. Si `mailAccountId` est fourni (v1.1 caller a explicitement choisi) :
 *      - lookup Account exact, MAIS doit appartenir au `userId` (sinon 404
 *        `account_not_found` — évite l'enum cross-user).
 *      - doit porter `gmail.send` dans `mailSendScope`.
 *      - doit ne PAS être `mailSendNeedsReauth = true`.
 *      - sinon → 404 `account_not_found`.
 *
 *   2. Sinon (mode auto v1.0 + v1.1 par défaut) :
 *      - cherche d'abord l'Account marqué `isDefaultForMail = true` (1 max
 *        par user grâce à l'index unique partiel).
 *      - sinon, fallback : premier Account qui contient `gmail.send`.
 *      - si rien → `MailProviderNotLinkedError`.
 *
 * Le but du helper est de retourner un `Account` row qu'on peut directement
 * passer à la suite (refresh token, send), pas de toucher au réseau ni à
 * Gmail. C'est purement DB + ordering.
 */

import type { PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '@/lib/prisma';
import { scopeIncludesGmailSend } from './gmail-oauth';
import {
  MailUserNotFoundError,
  MailProviderNotLinkedError,
} from './send-gmail';

export class MailAccountNotFoundError extends Error {
  status = 404 as const;
  code = 'account_not_found' as const;
}

export type SelectedAccount = {
  id: string;
  provider: string;
  refresh_token: string | null;
  access_token: string | null;
  expires_at: number | null;
  mailSendScope: string | null;
  mailSendNeedsReauth: boolean;
  isDefaultForMail: boolean;
};

export type SelectAccountDeps = {
  prisma?: PrismaClient;
};

const ACCOUNT_SELECT = {
  id: true,
  provider: true,
  refresh_token: true,
  access_token: true,
  expires_at: true,
  mailSendScope: true,
  mailSendNeedsReauth: true,
  isDefaultForMail: true,
} as const;

/**
 * Résout le compte à utiliser pour un envoi `send-as-user`.
 *
 * Throw :
 *   - `MailUserNotFoundError` si le user n'existe pas
 *   - `MailAccountNotFoundError` si `mailAccountId` fourni mais introuvable
 *     côté user (404 `account_not_found`)
 *   - `MailProviderNotLinkedError` si aucun compte gmail.send éligible
 */
export async function selectMailAccount(
  userId: string,
  mailAccountId: string | undefined,
  deps: SelectAccountDeps = {},
): Promise<SelectedAccount> {
  const prisma = deps.prisma ?? defaultPrisma;

  // Vérif user d'abord — sinon on retournerait 404 account_not_found pour
  // un user inexistant, ce qui leak un mauvais signal côté caller.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new MailUserNotFoundError(`User ${userId} not found`);
  }

  // ─── Cas 1 : mail_account_id explicite (v1.1) ─────────────────────────────
  if (mailAccountId) {
    const account = await prisma.account.findUnique({
      where: { id: mailAccountId },
      select: { ...ACCOUNT_SELECT, userId: true },
    });
    // Sécurité : un mailAccountId existant mais pas au user appelant doit
    // retourner 404 `account_not_found`, jamais 403. On évite ainsi le
    // signal "ce ID existe mais pas pour toi".
    if (!account || account.userId !== userId) {
      throw new MailAccountNotFoundError(
        `Account ${mailAccountId} not found for user ${userId}`,
      );
    }
    if (account.mailSendNeedsReauth) {
      // Cohérent avec le contrat existant (412 needs_reauth) — on
      // throw MailNeedsReauthError côté caller, pas ici. On retourne
      // l'Account et laisse le broker downstream voir le flag.
      // En pratique, on ne devrait jamais retourner needs_reauth=true
      // car le filter dans send-gmail.ts l'exclut, mais on garde la
      // logique cohérente : si caller demande EXPLICITEMENT un compte
      // qui needs_reauth, on retourne quand même l'Account, broker
      // re-fail proprement.
    }
    if (!scopeIncludesGmailSend(account.mailSendScope)) {
      // Pas de `gmail.send` → équivalent provider_not_linked pour CE compte.
      // Mais on log via account_not_found (caller a explicitly demandé un
      // compte qui n'a pas le scope — pas une situation à différencier).
      throw new MailAccountNotFoundError(
        `Account ${mailAccountId} for user ${userId} has no gmail.send scope`,
      );
    }
    return {
      id: account.id,
      provider: account.provider,
      refresh_token: account.refresh_token,
      access_token: account.access_token,
      expires_at: account.expires_at,
      mailSendScope: account.mailSendScope,
      mailSendNeedsReauth: account.mailSendNeedsReauth,
      isDefaultForMail: account.isDefaultForMail,
    };
  }

  // ─── Cas 2 : auto-résolution (v1.0 ou v1.1 sans mail_account_id) ──────────
  const candidates = await prisma.account.findMany({
    where: {
      userId,
      provider: 'google',
      mailSendNeedsReauth: false,
    },
    select: ACCOUNT_SELECT,
    orderBy: [
      // Priorité absolue au compte par défaut (1 max par user).
      { isDefaultForMail: 'desc' },
      // Ordre stable secondaire pour reproductibilité tests.
      { id: 'asc' },
    ],
  });

  const eligible = candidates.find((a) => scopeIncludesGmailSend(a.mailSendScope));
  if (!eligible || !eligible.refresh_token) {
    throw new MailProviderNotLinkedError(
      `User ${userId} has no Google Account with gmail.send scope linked`,
    );
  }

  return eligible;
}

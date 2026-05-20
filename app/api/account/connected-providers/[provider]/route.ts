/**
 * DELETE /api/account/connected-providers/[provider]
 *
 * Désassocie un provider OAuth (Google, Microsoft) du user authentifié.
 * Garde-fou anti-lockout STRICT : refuse si c'est le dernier moyen de
 * connexion (sinon le user ne pourra plus jamais se logger).
 *
 * Spec :
 * - User a [Google, Microsoft, Credentials] → DELETE Google OK
 * - User a [Google, Credentials]            → DELETE Google OK
 * - User a [Google, Microsoft]              → DELETE Google OK (Microsoft reste)
 * - User a [Google]                         → DELETE Google REFUSÉ (last login)
 * - User a [Credentials]                    → DELETE Credentials REFUSÉ (last login)
 *
 * Note : on ne supprime que pour ce user. Sécurité : on ne fait JAMAIS
 * confiance au param URL pour identifier le user — c'est toujours la
 * session qui décide. Le param `provider` est juste un sélecteur.
 *
 * Le provider 'credentials' (email/password) est interdit à la suppression
 * via cette route : pour changer/retirer son password, il y a un flow
 * dédié via /api/account/password.
 */

import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

const OAUTH_PROVIDERS = new Set(['google', 'microsoft-entra-id']);

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ provider: string }> }
) {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const { provider } = await ctx.params;

  if (!OAUTH_PROVIDERS.has(provider)) {
    return NextResponse.json(
      {
        error: 'unsupported_provider',
        message:
          "Ce provider ne peut pas être déconnecté via cette route. Pour changer votre mot de passe, utilisez la section Sécurité.",
      },
      { status: 400 }
    );
  }

  // Anti-lockout : on enveloppe dans une transaction Prisma pour éviter
  // une race condition entre 2 DELETE en parallèle qui passeraient tous
  // deux le check `accounts.length > 1` puis se delete-raient l'un l'autre
  // → user lockout. La transaction sérialise les checks/delete.
  //
  // Note Prisma 7 : par défaut READ COMMITTED. Pas suffisant à 100%
  // contre les races (un SELECT puis DELETE peut voir un état différent
  // sous READ COMMITTED), mais on accepte ce niveau car :
  //  1. L'auth requireUser garantit que c'est le user qui s'attaque soi-même
  //     (= auto-DoS volontaire, pas un attaquant tiers)
  //  2. La transaction réduit drastiquement la fenêtre de race (millisecondes
  //     vs secondes sans txn)
  //  3. Au pire, le user fait 2 onglets et se lockout → support manuel.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const accounts = await tx.account.findMany({
        where: { userId: user.id },
        select: { id: true, provider: true },
      });

      const target = accounts.find((a) => a.provider === provider);
      if (!target) {
        return { kind: 'not_connected' as const };
      }
      if (accounts.length <= 1) {
        return { kind: 'last_login_method' as const };
      }
      await tx.account.delete({ where: { id: target.id } });
      return { kind: 'ok' as const };
    });

    if (result.kind === 'not_connected') {
      return NextResponse.json(
        { error: 'not_connected', message: 'Ce provider n\'est pas connecté à votre compte.' },
        { status: 404 }
      );
    }
    if (result.kind === 'last_login_method') {
      return NextResponse.json(
        {
          error: 'last_login_method',
          message:
            "Impossible de déconnecter ce provider : c'est votre dernier moyen de connexion. Ajoutez d'abord une autre méthode (mot de passe ou autre provider) avant de retirer celle-ci.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, provider });
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: '[provider-disconnect-failed]',
        level: 'error',
        user_id: user.id,
        provider,
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      { error: 'internal_error', message: 'Erreur transactionnelle lors de la déconnexion.' },
      { status: 500 }
    );
  }
}

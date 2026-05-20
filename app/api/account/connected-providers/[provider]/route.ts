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

  // Anti-lockout : on compte les accounts du user AVANT de supprimer.
  // Si c'est le dernier (count === 1), on refuse — quel que soit le provider.
  const accounts = await prisma.account.findMany({
    where: { userId: user.id },
    select: { id: true, provider: true },
  });

  const target = accounts.find((a) => a.provider === provider);
  if (!target) {
    return NextResponse.json(
      { error: 'not_connected', message: 'Ce provider n\'est pas connecté à votre compte.' },
      { status: 404 }
    );
  }

  if (accounts.length <= 1) {
    return NextResponse.json(
      {
        error: 'last_login_method',
        message:
          "Impossible de déconnecter ce provider : c'est votre dernier moyen de connexion. Ajoutez d'abord une autre méthode (mot de passe ou autre provider) avant de retirer celle-ci.",
      },
      { status: 409 }
    );
  }

  await prisma.account.delete({ where: { id: target.id } });

  return NextResponse.json({ success: true, provider });
}

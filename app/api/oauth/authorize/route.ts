/**
 * Décision du consentement (formulaire de /oauth/authorize). Revalide tout : session, origine,
 * client, adresse de retour, PKCE. Le code n'est émis qu'au titulaire, adresse prouvée, hors
 * impersonation.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { getCurrentUser } from '@/lib/auth/get-user';
import { hubIssuer } from '@/lib/mcp/config';
import { lireParams } from '@/lib/mcp/http';
import { creerCode, validerDemande } from '@/lib/mcp/oauth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function vers(redirectUri: string, params: Record<string, string | null | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString(), 303);
}

export async function POST(request: NextRequest) {
  // Formulaire d'une autre origine : refusé (le cookie Lax le bloque déjà, ceci le garantit).
  const origine = request.headers.get('origin');
  if (origine !== hubIssuer()) return NextResponse.json({ error: 'origine refusée' }, { status: 403 });

  const user = await getCurrentUser();
  if (!user?.supabaseUserId) return NextResponse.json({ error: 'non connecté' }, { status: 401 });
  const session = await auth();
  if (session?.user?.impersonated === true) return NextResponse.json({ error: 'impersonation' }, { status: 403 });
  if (!(await isEmailProvenForSession(user.id))) return NextResponse.json({ error: 'adresse non prouvée' }, { status: 403 });

  const p = await lireParams(request);
  const v = await validerDemande(prisma, p);
  if (!v.ok && v.fatale) return NextResponse.json(v.erreur.corps(), { status: 400 });
  const iss = hubIssuer();
  if (!v.ok) return vers(v.redirectUri!, { error: v.erreur.code, error_description: v.erreur.description, state: v.state, iss });

  if (p.decision !== 'autoriser') {
    return vers(v.demande.redirectUri, { error: 'access_denied', state: v.demande.state, iss });
  }
  const code = await creerCode(prisma, v.demande, user.supabaseUserId);
  await prisma.auditLog
    .create({ data: { action: 'mcp.oauth.consent', actor: `user:${user.supabaseUserId}`, targetType: 'oauth_client', targetId: v.demande.clientId, payload: { client: v.demande.clientName } } })
    .catch(() => {});
  return vers(v.demande.redirectUri, { code, state: v.demande.state, iss });
}

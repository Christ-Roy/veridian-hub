import { NextRequest, NextResponse } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { PAR_CLE } from '@/lib/auth/emprunt-bornes';
import { createImpersonationToken } from '@/lib/auth/impersonation';
import { ficheClient } from '@/lib/emprunt/entrees';
import { ouvrirEmprunt } from '@/lib/emprunt/journal';
import { prisma } from '@/lib/prisma';
import { getURL } from '@/utils/helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/impersonate
 * Body: { email: string, raison?: string }
 *
 * Generates auto-login URLs for all services for a given user.
 * Useful for debugging/support — login as any user without knowing their password.
 *
 * Hub login : on génère un **token impersonate court-vécu** (10 min, usage
 * unique, stocké hashé — cf. lib/auth/impersonation.ts) et on retourne le
 * lien `/api/auth/impersonate-callback?token=<rawToken>`. Ouvrir ce lien
 * dans le navigateur consomme le token et pose le cookie de session Auth.js
 * du user cible (JWT marqué `impersonated`). Le volet session est aussi
 * disponible isolément via POST /api/auth/impersonate-set.
 *
 * NB : la stratégie de session du Hub est `jwt` — créer une row dans la
 * table `sessions` ne produit AUCUNE session valide (Auth.js ne la lit
 * jamais en mode JWT). C'est pourquoi on passe par un JWT encodé.
 */
export async function POST(request: NextRequest) {
  // Auth admin durcie : x-admin-secret en comparaison timing-safe OU session
  // platform admin, + rate-limit IP. `authenticateAdmin` rejette aussi toute
  // session impersonée (anti-ré-impersonation) — un user impersoné ne peut
  // pas relancer une impersonation. Cf. lib/admin/authenticate.ts.
  const adminAuth = await authenticateAdmin(request);
  if (!adminAuth.ok) return adminAuth.response;

  let body: { email?: unknown; raison?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email : '';
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }

  // Les mêmes apps, relues de la même façon que l'écran /dashboard/admin/clients.
  const fiche = user.supabaseUserId ? await ficheClient(prisma, user.supabaseUserId) : null;
  // Journal d'abord : sans trace, pas de lien.
  const empruntId = await ouvrirEmprunt(prisma, {
    par: adminAuth.hubUserId ?? PAR_CLE,
    acteur: adminAuth.sessionEmail ? `admin:${adminAuth.sessionEmail}` : 'token:ADMIN_SECRET',
    cible: { id: user.id, email: user.email, hubUserId: user.supabaseUserId },
    raison: body.raison as string | null,
    via: 'lien',
  });
  const { rawToken, expires } = await createImpersonationToken(prisma, user.id, empruntId);
  const hubLink = `${getURL('/api/auth/impersonate-callback')}?token=${encodeURIComponent(rawToken)}`;

  return NextResponse.json({
    user_id: user.supabaseUserId ?? user.id,
    email,
    tenant_id: fiche?.organisations[0]?.id ?? null,
    emprunt: empruntId,
    // Un seul jeton, à usage unique : ouvrir l'un des liens consomme les autres. `null` : l'app n'ouvrirait pas, `apps` dit pourquoi.
    links: Object.fromEntries((fiche?.apps ?? [{ app: 'hub', entrable: true }]).map((a) => [a.app, !a.entrable ? null : a.app === 'hub' ? hubLink : `${hubLink}&vers=${a.app}`])),
    apps: (fiche?.apps ?? []).map((a) => ({ app: a.app, libelle: a.libelle, etat: a.etat, entrable: a.entrable, detail: a.detail })),
    session: { token: rawToken, expires: expires.toISOString() },
  });
}

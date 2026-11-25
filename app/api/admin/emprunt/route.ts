/**
 * POST { hubUserId, app, tenantId?, raison? } : l'administrateur entre chez un client, depuis l'écran (VER-263). Session d'un administrateur de plateforme
 * seulement, jamais la clé. La session du client remplace la sienne une heure ; la sienne attend dans le cookie de retour. Aucun rôle ne change chez le client.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isPlatformAdminId } from '@/lib/admin/liste-admins';
import { refusAdmin } from '@/lib/admin/require-admin';
import { sessionAdmin } from '@/lib/admin/session-admin';
import { APPS_ECRAN, entreeDe } from '@/lib/emprunt/entrees';
import { ouvrirEmprunt, suiteEmprunt } from '@/lib/emprunt/journal';
import { CHEMIN_RETOUR, cookieRetour, scellerRetour } from '@/lib/emprunt/retour';
import { encodeImpersonationSessionJwt, IMPERSONATION_SESSION_TTL_S, secureCookiesEnabled, sessionCookieName } from '@/lib/auth/impersonation';
import { adminApiLimiter, extractClientIp } from '@/lib/auth/rate-limit';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { COOKIE_ACTIF, organisationActive } from '@/lib/tenants/actif';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ hubUserId: z.string().uuid(), app: z.enum(APPS_ECRAN), tenantId: z.string().uuid().nullish(), raison: z.string().max(2000).nullish() });
const refus = (status: number, error: string, message: string) => NextResponse.json({ error, message }, { status });

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (request.headers.get('origin') !== base.origin) return refus(403, 'forbidden_origin', 'Origine refusée.');
  const rate = adminApiLimiter.enforceWithBypass(extractClientIp(request.headers), request.headers);
  if (!rate.ok) return refus(429, 'rate_limited', 'Trop de tentatives, attendez une minute.');
  const s = await sessionAdmin();
  if (!s.ok) return refusAdmin(s.raison);
  const corps = Corps.safeParse(await request.json().catch(() => null));
  if (!corps.success) return refus(400, 'invalid_body', 'Demande illisible.');
  const { hubUserId, app, tenantId, raison } = corps.data;

  const cible = await prisma.user.findFirst({ where: { supabaseUserId: hubUserId }, select: { id: true, email: true, name: true, image: true, supabaseUserId: true } });
  if (!cible) return refus(404, 'user_not_found', 'Ce compte n\'existe pas au Hub.');
  if (cible.id === s.userId) return refus(409, 'soi_meme', 'C\'est votre compte : ouvrez l\'app directement.');
  if (isPlatformAdminId(cible.supabaseUserId)) return refus(403, 'cible_admin', 'On n\'entre pas chez un administrateur de plateforme.');
  if (tenantId && (await organisationActive(prisma, hubUserId, { par: 'personne' }, tenantId)) !== tenantId) return refus(409, 'organisation_indisponible', 'Cette organisation n\'est pas, ou plus, la sienne, ou elle est suspendue.');
  const vers = entreeDe(app);
  if (!vers) return refus(409, 'not_configured', 'Cette app n\'est pas branchée ici.');
  const secure = secureCookiesEnabled();
  const sienne = request.cookies.get(sessionCookieName(secure))?.value;
  if (!sienne) return refus(409, 'session_illisible', 'Votre session ne peut pas être gardée de côté : reconnectez-vous.');

  let empruntId: string;
  try {
    empruntId = await ouvrirEmprunt(prisma, { par: s.hubUserId, acteur: `admin:${s.email}`, cible: { id: cible.id, email: cible.email, hubUserId }, raison, tenantId, app, via: 'ecran' });
  } catch (err) {
    console.error('[emprunt]', err instanceof Error ? err.message.slice(0, 160) : 'erreur');
    return refus(503, 'journal_indisponible', 'Le journal ne s\'écrit pas : sans trace, pas d\'entrée.');
  }
  const jeton = await encodeImpersonationSessionJwt({ user: cible, impersonatedBy: s.hubUserId, empruntId, secure });
  const retour = await scellerRetour({ empruntId, session: sienne, org: request.cookies.get(COOKIE_ACTIF)?.value ?? null });
  await suiteEmprunt(prisma, { action: 'consume', empruntId, par: s.hubUserId, userId: cible.id, detail: { via: 'ecran' } });

  const res = NextResponse.json({ ok: true, url: vers, emprunt: empruntId });
  const commun = { httpOnly: true, secure, sameSite: 'lax' as const };
  res.cookies.set(sessionCookieName(secure), jeton, { ...commun, path: '/', maxAge: IMPERSONATION_SESSION_TTL_S });
  res.cookies.set(cookieRetour(secure), retour, { ...commun, sameSite: 'strict', path: CHEMIN_RETOUR, maxAge: IMPERSONATION_SESSION_TTL_S });
  if (tenantId) res.cookies.set(COOKIE_ACTIF, tenantId, { ...commun, path: '/', maxAge: IMPERSONATION_SESSION_TTL_S });
  else res.cookies.set(COOKIE_ACTIF, '', { ...commun, path: '/', maxAge: 0 });
  return res;
}

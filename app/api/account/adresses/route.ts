/**
 * Les adresses de la personne connectée (VER-227 S1b, AD-M3). GET : la liste. POST : demander un code, le confirmer, prouver par le fournisseur de son
 * organisation, rendre principale, détacher. Preuve récente, jamais une session d'emprunt ni celle qu'un fournisseur d'organisation a ouverte.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { adressesProuvees, confirmerCode, demanderCode, detacher } from '@/lib/adresses';
import { fournisseurPour } from '@/lib/adresses/federation';
import { direArret } from '@/lib/adresses/garde';
import { promouvoir, type RefusPromotion } from '@/lib/adresses/promotion';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { getCurrentUser } from '@/lib/auth/get-user';
import { denyIfImpersonated, denyUnlessRecentAuth, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { CHEMIN_RETOUR, COOKIE_FEDERATION, demarrer, TRANSACTION_S } from '@/lib/federation/oidc';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Adresse = z.string().max(254).transform(normaliserEmail).pipe(z.string().email());
const Corps = z.discriminatedUnion('geste', [
  z.strictObject({ geste: z.literal('demander'), email: Adresse }),
  z.strictObject({ geste: z.literal('confirmer'), email: Adresse, code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({ geste: z.literal('detacher'), email: Adresse }),
  z.strictObject({ geste: z.literal('federer'), email: Adresse }),
  z.strictObject({ geste: z.literal('promouvoir'), email: Adresse }),
]);
/** Chaque promotion interroge les apps ; chaque preuve, le fournisseur. */
const debit = { promouvoir: new RateLimiter({ capacity: 10, windowMs: 60 * 60_000, name: 'adresse-promotion' }), federer: new RateLimiter({ capacity: 20, windowMs: 60 * 60_000, name: 'adresse-federer' }) };
const STATUT: Record<RefusPromotion, number> = { not_found: 404, email_not_verified: 403, domaine_federe: 403, preuve_perdue: 403, app_par_adresse: 409, app_non_reliee: 409, app_indisponible: 503, app_refuse: 409, prise: 409 };
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

async function personne() {
  const u = await getCurrentUser();
  return u ? prisma.user.findUnique({ where: { id: u.id }, select: { id: true, email: true, emailVerified: true, supabaseUserId: true } }) : null;
}

export async function GET() {
  const u = await personne();
  if (!u) return rendre({ error: 'unauthorized' }, 401);
  const prouvees = await adressesProuvees(prisma, u);
  return rendre({ principale: u.email, principale_prouvee: Boolean(u.emailVerified), secondaires: prouvees.filter((e) => e !== normaliserEmail(u.email)) });
}

export async function POST(request: NextRequest) {
  const u = await personne();
  if (!u) return rendre({ error: 'unauthorized' }, 401);
  const refus = (await denyIfImpersonated()) ?? (await denyUnlessRecentAuth(PREUVE_COMPTE_S));
  if (refus) return refus;
  // Une adresse non prouvée ne donne aucun droit, pas même celui d'en ajouter une.
  if (!u.emailVerified) return rendre({ error: 'email_not_verified' }, 403);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!c.success) return rendre({ error: 'invalid' }, 400);
  const d = c.data;
  if (d.geste === 'demander') {
    const r = await demanderCode(prisma, u, d.email);
    return r === 'trop' ? rendre({ error: 'rate_limited' }, 429) : rendre({ ok: true });
  }
  if (d.geste === 'confirmer') {
    const r = await confirmerCode(prisma, u, d.email, d.code);
    return r === 'ajoutee' ? rendre({ ok: true }) : rendre({ error: r }, r === 'prise' ? 409 : 400);
  }
  if ((d.geste === 'federer' || d.geste === 'promouvoir') && !debit[d.geste].enforce(u.id).ok) return rendre({ error: 'rate_limited' }, 429);
  if (d.geste === 'federer') {
    const i = await fournisseurPour(prisma, u, d.email);
    if (!i) return rendre({ error: 'domaine_non_federe' }, 404);
    try {
      const base = getHubBaseUrl(request.url);
      const s = await demarrer(i, new URL(CHEMIN_RETOUR, base).href, undefined, { userId: u.id, email: d.email });
      const r = rendre({ ok: true, url: s.url });
      r.cookies.set(COOKIE_FEDERATION, s.cookie, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR, maxAge: TRANSACTION_S });
      return r;
    } catch (err) {
      console.error(JSON.stringify({ tag: '[federation]', level: 'error', msg: 'fournisseur injoignable', idp: i.id, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
      return rendre({ error: 'fournisseur_injoignable' }, 503);
    }
  }
  if (d.geste === 'promouvoir') {
    const r = await promouvoir(prisma, u, d.email);
    if (!('refus' in r)) return rendre({ ok: true, principale: r.promue, reconnect: true, apps_failed: r.appsEnEchec });
    const arret = r.refus === 'app_par_adresse' || r.refus === 'app_non_reliee' || r.refus === 'app_indisponible' ? { message: direArret(r) } : {};
    return rendre({ error: r.refus, ...(r.apps ? { apps: r.apps } : {}), ...arret }, STATUT[r.refus]);
  }
  return (await detacher(prisma, u, d.email)) ? rendre({ ok: true }) : rendre({ error: 'not_found' }, 404);
}

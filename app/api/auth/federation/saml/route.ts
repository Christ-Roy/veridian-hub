/**
 * POST : la réponse SAML du fournisseur d'une organisation, envoyée par le navigateur depuis chez lui. Vérifiée ici ; la session n'y est pas lisible (cookie
 * d'un autre site), la suite se fait donc sur notre page, avec l'identité scellée 60 s dans CE navigateur.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { ipClient } from '@/lib/auth/ip-client';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { idpDe, sortieDe } from '@/lib/federation/conclure';
import { ouvrir } from '@/lib/federation/oidc';
import { CHEMIN_ACS, CHEMIN_SUITE, COOKIE_SAML, COOKIE_SUITE, scellerSuite, SUITE_S, terminerSaml } from '@/lib/federation/saml';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 30, windowMs: 60_000, name: 'federation-saml' });

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  if (!debit.enforce(ipClient(request.headers)).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  if (Number(request.headers.get('content-length') ?? 0) > 400_000) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  const s = sortieDe(base, { nom: COOKIE_SAML, chemin: CHEMIN_ACS });
  const t = ouvrir(request.cookies.get(COOKIE_SAML)?.value);
  if (!t) return s.refus('demande_expiree');
  const i = await idpDe(t);
  if (!i || i.protocole !== 'saml') return s.refus('organisation_indisponible');
  const reponse = (await request.formData().catch(() => null))?.get('SAMLResponse');
  let identite;
  try {
    if (typeof reponse !== 'string') throw new Error('absente');
    identite = await terminerSaml(i, t, reponse, base);
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    return s.refus(code === 'identifiant_non_durable' ? code : 'reponse_refusee', code.replace(/\s+/g, ' '));
  }
  const r = s.vers(CHEMIN_SUITE);
  r.cookies.set(COOKIE_SUITE, scellerSuite(t, identite), { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_SUITE, maxAge: SUITE_S });
  return r;
}

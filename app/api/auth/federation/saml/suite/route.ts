/** GET : la suite d'une réponse SAML vérifiée, sur notre site, avec la session de la personne. L'identité scellée sert une fois, 60 s. */
import type { NextRequest } from 'next/server';

import { conclure, idpDe, sortieDe } from '@/lib/federation/conclure';
import { CHEMIN_SUITE, COOKIE_SUITE, ouvrirSuite } from '@/lib/federation/saml';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const s = sortieDe(base, { nom: COOKIE_SUITE, chemin: CHEMIN_SUITE });
  const x = ouvrirSuite(request.cookies.get(COOKIE_SUITE)?.value);
  if (!x) return s.refus('demande_expiree');
  const i = await idpDe(x.transaction);
  if (!i || i.protocole !== 'saml') return s.refus('organisation_indisponible');
  return conclure(request, base, i, x.transaction, x.identite, s);
}

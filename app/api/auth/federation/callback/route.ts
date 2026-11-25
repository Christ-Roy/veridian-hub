/**
 * GET : le retour du fournisseur OIDC d'une organisation. La transaction est dans le cookie scellé de CE navigateur, détruite à chaque retour ; tout ce que
 * le fournisseur affirme est vérifié avant d'être lu. La suite (lib/federation/conclure.ts) est la même qu'en SAML.
 */
import type { NextRequest } from 'next/server';

import { conclure, idpDe, sortieDe } from '@/lib/federation/conclure';
import { CHEMIN_RETOUR, COOKIE_FEDERATION, ouvrir, terminer } from '@/lib/federation/oidc';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const s = sortieDe(base, { nom: COOKIE_FEDERATION, chemin: CHEMIN_RETOUR });
  const t = ouvrir(request.cookies.get(COOKIE_FEDERATION)?.value);
  if (!t) return s.refus('demande_expiree');
  const i = await idpDe(t);
  if (!i || i.protocole === 'saml') return s.refus('organisation_indisponible');
  let identite;
  try {
    identite = await terminer(i, t, new URL(`${CHEMIN_RETOUR}${new URL(request.url).search}`, base));
  } catch (err) {
    return s.refus('reponse_refusee', err instanceof Error ? `${err.name} ${(err as { code?: string }).code ?? ''}` : undefined);
  }
  return conclure(request, base, i, t, identite, s);
}

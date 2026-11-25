/** Partir vers le fournisseur d'une organisation, quel que soit son protocole : où aller, et le cookie de CE navigateur. */
import type { NextResponse } from 'next/server';

import type { IdpPret } from './idp';
import { CHEMIN_RETOUR, COOKIE_FEDERATION, demarrer, TRANSACTION_S } from './oidc';
import { CHEMIN_ACS, COOKIE_SAML, demarrerSaml } from './saml';

export type Depart = { url: string; poser: (r: NextResponse) => void };

export async function partir(i: IdpPret, base: URL, o: { relier?: { userId: string }; essai?: { userId: string }; prouver?: { userId: string } } = {}): Promise<Depart> {
  const sur = base.protocol === 'https:';
  if (i.protocole === 'saml') {
    const d = await demarrerSaml(i, base, o);
    // Le fournisseur poste sa réponse depuis chez lui : sans SameSite=None, ce cookie ne reviendrait pas. Borné à ce chemin, scellé, 10 min.
    return { url: d.url, poser: (r) => void r.cookies.set(COOKIE_SAML, d.cookie, { httpOnly: true, secure: sur, sameSite: sur ? 'none' : 'lax', path: CHEMIN_ACS, maxAge: TRANSACTION_S }) };
  }
  const d = await demarrer(i, new URL(CHEMIN_RETOUR, base).href, undefined, undefined, o.relier, o.essai, o.prouver);
  return { url: d.url, poser: (r) => void r.cookies.set(COOKIE_FEDERATION, d.cookie, { httpOnly: true, secure: sur, sameSite: 'lax', path: CHEMIN_RETOUR, maxAge: TRANSACTION_S }) };
}

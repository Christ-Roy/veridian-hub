// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Fournisseur } from '@/app/dashboard/organisation/Fournisseur';

const A = { retour: 'https://h/retour', acs: 'https://h/acs', entite: 'https://h/saml/T', connexion: 'https://h/connexion/asd' };
const idp = (o: object = {}) => ({ id: 'i', issuer: 'https://login.infomaniak.com', client_id: 'c', domaines: [], creation_auto: false, actif: false, pose_le: '', protocole: 'oidc', sso_url: null, libre_service: true, essai_le: null, alias: null, ...o });
const html = (i: ReturnType<typeof idp> | null) => renderToStaticMarkup(<Fournisseur tenant="T" idp={i as never} adresses={A} />);
const gestes = (h: string) => ['Essayer', 'Activer', 'Couper', 'Retirer'].filter((g) => h.includes(`>${g}</button>`));

describe('Fournisseur', () => {
  it('rien encore : les deux protocoles, avec ce qu\'il faut donner chez eux', () => {
    const h = html(null);
    for (const t of ['OpenID Connect', 'SAML 2.0', A.retour, A.acs, A.entite]) expect(h).toContain(t);
    expect(gestes(h)).toEqual([]);
  });
  it('posé, jamais essayé : pas de bouton Activer', () => expect(gestes(html(idp()))).toEqual(['Essayer', 'Retirer']));
  it('essayé : activable ; actif : coupable, avec la porte à partager', () => {
    expect(gestes(html(idp({ essai_le: 'x' })))).toEqual(['Essayer', 'Activer', 'Retirer']);
    const h = html(idp({ essai_le: 'x', actif: true }));
    expect([gestes(h), h.includes(A.connexion)]).toEqual([['Essayer', 'Couper', 'Retirer'], true]);
  });
  it('posé par Veridian : aucun geste, aucun formulaire', () => {
    const h = html(idp({ libre_service: false, actif: true }));
    expect([gestes(h), h.includes('<form')]).toEqual([[], false]);
  });
});

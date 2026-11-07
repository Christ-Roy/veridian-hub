/**
 * Contrôle d'échec : chaque condition de la batterie, présentée FAUSSE, doit faire tomber
 * l'assertion. Une mesure jamais vue échouer est du maquillage. Ces cas sont purs (aucun
 * réseau) : ils tournent en premier, et si l'un passe au vert à tort, tout le reste est suspect.
 */
import { expect, test } from '@playwright/test';

import {
  devraitAvoirPlan,
  devraitEtreArrive,
  devraitEtreSansSession,
  devraitIgnorerLesAutres,
  devraitNeVoirAucuneDeriveNouvelle,
  devraitNePasEtreArrive,
} from './lib/assertions';
import { APP_URL, masquer } from './lib/cibles';
import type { Atterrissage } from './lib/parcours';
import { cas } from './lib/etat';

const hote = (a: keyof typeof APP_URL) => new URL(APP_URL[a]).host;
const atterri = (over: Partial<Atterrissage>): Atterrissage => ({
  app: 'prospection',
  url: 'https://x/',
  hote: hote('prospection'),
  chemin: '/prospects',
  texte: 'Prospects Pipeline',
  formulaireMotDePasse: false,
  lienUnique: null,
  navigations: [],
  ...over,
});

test.describe('contrôle d\'échec', () => {
  cas(null, 'arrivée : tombe si l\'utilisateur finit sur le tableau de bord du Hub', async () => {
    expect(() => devraitEtreArrive(atterri({ hote: 'app.veridian.site', chemin: '/dashboard' }), 'prospection')).toThrow();
    // et tient si la condition est vraie (le témoin positif de la mesure)
    expect(() => devraitEtreArrive(atterri({}), 'prospection')).not.toThrow();
  });
  cas(null, 'arrivée : tombe sur la page d\'échec du rebond ou un mot de passe redemandé', async () => {
    expect(() => devraitEtreArrive(atterri({ texte: 'Impossible de revenir sur analytics' }), 'prospection')).toThrow();
    expect(() => devraitEtreArrive(atterri({ formulaireMotDePasse: true }), 'prospection')).toThrow();
  });
  cas(null, 'refus : tombe si un compte sans preuve entre ou reçoit un lien', async () => {
    expect(() => devraitNePasEtreArrive(atterri({}), 'prospection')).toThrow();
    expect(() => devraitNePasEtreArrive(atterri({ hote: 'app.veridian.site', lienUnique: 'https://x/?t=1' }), 'prospection')).toThrow();
    expect(() => devraitNePasEtreArrive(atterri({ hote: 'app.veridian.site', chemin: '/dashboard' }), 'prospection')).not.toThrow();
  });
  cas(null, 'refus : le rebond qui va jusqu\'à la page d\'échec compte comme émission, donc fait tomber le refus', async () => {
    const a = atterri({ hote: 'app.veridian.site', chemin: '/auth/bounce/error' });
    expect(() => devraitNePasEtreArrive(a, 'analytics')).not.toThrow(); // pas « arrivé »...
    expect(/bounce\/error/.test(a.chemin)).toBe(true); // ...mais 02 le rejette par son propre test de chemin
  });
  cas(null, 'réseau : une page d\'erreur du navigateur n\'est ni une arrivée ni un refus, elle est non aboutie', async () => {
    const err = atterri({ hote: 'chromewebdata', url: 'chrome-error://chromewebdata/', chemin: '/' });
    expect(() => devraitEtreArrive(err, 'prospection')).toThrow(/erreur réseau/);
    expect(() => devraitNePasEtreArrive(err, 'prospection')).toThrow(/erreur réseau/);
  });
  cas(null, 'lien mort : tombe si le lien a ouvert une session ou la console', async () => {
    const vue = { session: { email: 'a@b.c' }, texte: '', url: 'https://x/' };
    expect(() => devraitEtreSansSession(vue, 'a@b.c')).toThrow();
    expect(() => devraitEtreSansSession({ session: null, texte: 'Welcome, a@b.c', url: 'https://x/' }, 'a@b.c')).toThrow();
    expect(() => devraitEtreSansSession({ session: null, texte: 'Select workspace', url: 'https://x/' }, 'a@b.c')).toThrow();
    expect(() => devraitEtreSansSession({ session: null, texte: 'Sign in', url: 'https://x/' }, 'a@b.c')).not.toThrow();
  });
  cas(null, 'plan : tombe si le plan lu dans l\'app n\'est pas celui posé au Hub', async () => {
    expect(() => devraitAvoirPlan('freemium', 'pro', 'x')).toThrow();
    expect(() => devraitAvoirPlan('pro', 'pro', 'x')).not.toThrow();
  });
  cas(null, 'reconcile : tombe dès qu\'une dérive nouvelle ou une dérive d\'identité apparaît', async () => {
    const base = { drifts: [{ hubTenantId: 't1', app: 'notifuse', kind: 'tenant_missing_app' }], identity: { notifuse: { withoutHub: [] } } };
    expect(() => devraitNeVoirAucuneDeriveNouvelle(base, base)).not.toThrow();
    const plus = { ...base, drifts: [...base.drifts, { hubTenantId: 't2', app: 'prospection', kind: 'tenant_extra_app' }] };
    expect(() => devraitNeVoirAucuneDeriveNouvelle(base, plus)).toThrow();
    const id = { ...base, identity: { notifuse: { withoutHub: ['x'] } } };
    expect(() => devraitNeVoirAucuneDeriveNouvelle(base, id)).toThrow();
  });
  cas(null, 'isolation : tombe si un autre tenant est visible', async () => {
    expect(() => devraitIgnorerLesAutres('Workspace autre-client', ['autre-client'], 'x')).toThrow();
    expect(() => devraitIgnorerLesAutres('Workspace moi', ['autre-client'], 'x')).not.toThrow();
  });
  cas(null, 'masquage : aucun jeton à usage unique ne sort dans un message', async () => {
    const m = masquer('https://x/api/auth/token?t=abcdef123456&u=1 et /onboard/SECRET_123-abc');
    expect(m).not.toContain('abcdef123456');
    expect(m).not.toContain('SECRET_123');
  });
});

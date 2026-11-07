/**
 * Index des tests qui tiennent les invariants d'identité. Chaque ligne nomme l'invariant, le fichier
 * et un fragment du titre du test. Si quelqu'un renomme, vide ou supprime l'un de ces tests, cet index
 * échoue et dit lequel : une garde qui disparaît en silence ne garde plus rien.
 *
 * Les nouveaux tests de cette famille sont dans ce dossier. La preuve de bout en bout (vrai navigateur,
 * prod) est la batterie `e2e/systeme-sso` ; sa correspondance est dans docs/PARCOURS-IDENTITE.md.
 */
import { describe, expect, it } from 'vitest';

import { lire } from './source';

const GARDES: Array<[invariant: string, fichier: string, titre: string]> = [
  ['révocation : un iat réécrit ne sauve pas', '__tests__/lib/auth/session-revocation.test.ts', 'un iat réécrit après la révocation ne sauve pas'],
  ['révocation : compte supprimé', '__tests__/lib/auth/session-revocation.test.ts', 'compte supprimé : révoquée'],
  ['révocation : jeton sans date', '__tests__/lib/auth/session-revocation.test.ts', "jeton sans date : révoquée"],
  ['révocation : base en panne ne déconnecte personne', '__tests__/lib/auth/session-revocation.test.ts', 'base en panne'],
  ['révocation : l\'accusé des apps', '__tests__/lib/auth/revoke-all-sessions.test.ts', ''],
  ['authAt : One Tap', '__tests__/api/auth/callback/google-one-tap.test.ts', 'porte authAt et une durée d'],
  ['One Tap : refuse un compte à double vérification', '__tests__/api/auth/callback/google-one-tap.test.ts', 'compte avec double vérification : refusé'],
  ['authAt : MFA', '__tests__/api/auth/mfa/verify.test.ts', 'session Auth.js émise avec authAt'],
  ['MFA : plafond d\'essais', '__tests__/api/auth/mfa/verify.test.ts', 'le 6e essai dans la fenêtre est refusé'],
  ['MFA : sans cookie d\'étape 1', '__tests__/api/auth/mfa/verify.test.ts', 'sans cookie d'],
  ['authAt : impersonation', '__tests__/lib/auth/impersonation.test.ts', 'le JWT porte authAt'],
  ['impersonation : une heure', '__tests__/lib/auth/impersonation.test.ts', 'une impersonation de plus d une heure est expirée'],
  ['rebond : anti-boucle (3e essai rendu, 4e arrêt, compteur par app)', '__tests__/api/auth/bounce/prepare.test.ts', 'au troisième essai, retour à l'],
  ['rebond : site client non déclaré refusé', '__tests__/api/auth/bounce/prepare.test.ts', 'site client sous veridian.site, non déclaré comme app : refusé'],
  ['rebond : evil.com', '__tests__/api/auth/bounce/prepare.test.ts', 'next=https://evil.com'],
  ['rebond : Hub lui-même', '__tests__/api/auth/bounce/prepare.test.ts', 'anti-loop'],
  ['rebond : hôte de staging refusé en prod', '__tests__/lib/auth/bounce-next.test.ts', 'D13'],
  ['rebond : adresse non prouvée, aucun appel à l\'app', '__tests__/api/auth/bounce/complete.test.ts', 'adresse non prouvée → aucun appel à l'],
  ['rebond : hub_user_id jamais users.id', '__tests__/api/auth/bounce/complete.test.ts', 'users.id ne sert jamais de hub_user_id'],
  ['rebond : cookies vidés même en erreur', '__tests__/api/auth/bounce/complete.test.ts', 'anti-replay même sur erreur'],
  ['rebond : navigation réelle seule', '__tests__/api/auth/bounce/complete.test.ts', 'navigation réelle'],
  ['adresse non prouvée : toute route productrice est gardée', '__tests__/lib/auth/email-proof-routes.test.ts', 'est gardée'],
  ['adresse non prouvée : OAuth sans preuve ne relie pas', '__tests__/lib/auth/sign-in-callback.test.ts', 'REFUSE (D1)'],
  ['preuve d\'adresse : liée à l\'adresse', '__tests__/lib/auth/email-proof.test.ts', ''],
  ['callbackUrl : formulaires', '__tests__/components/auth/LoginForm.callback.test.tsx', ''],
  ['récent : preuve de connexion récente', '__tests__/lib/auth/recent-auth.test.ts', ''],
  ['récent : routes protégées', '__tests__/lib/auth/recent-auth-routes.test.ts', ''],
  ['reset : jeton haché et à usage unique', '__tests__/api/auth/reset-password.test.ts', ''],
  ['signup : doublon et limiteur', '__tests__/api/auth/signup.test.ts', ''],
  ['IP client : cf-connecting-ip', '__tests__/lib/auth/rate-limit.test.ts', 'cf-connecting-ip'],
];

describe('index des gardes d\'identité', () => {
  it.each(GARDES)('%s', (_invariant, fichier, titre) => {
    const src = lire(fichier);
    // Le test existe vraiment : au moins un it( ou test( dans le fichier, et le fragment de titre présent.
    expect(src).toMatch(/\b(it|test)(\.each\([^)]*\))?\(/);
    if (titre) expect(src).toContain(titre);
  });
});

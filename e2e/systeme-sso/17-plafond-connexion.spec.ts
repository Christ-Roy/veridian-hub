/**
 * Plafond d'essais de mot de passe par compte, sur ce qui est servi (23/11). Compte de test, Hub de STAGING seulement.
 * Chaque essai annonce une adresse différente : sans effet. Le bon mot de passe est ralenti depuis un navigateur inconnu,
 * et passe depuis un navigateur déjà entré dans ce compte. Épreuve : `SSO_SABOTAGE=plafond` change de compte à chaque
 * essai, le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin } from './lib/hub-admin';
import { creerCompteProuve } from './lib/parcours';

const ECHECS_MAX = 10;

async function essai(email: string, password: string, n: number, cookie?: string) {
  return fetch(`${HUB_URL}/api/auth/mfa/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': `203.0.113.${n}`,
      'x-real-ip': `203.0.113.${n}`,
      'x-forwarded-for': `203.0.113.${n}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
}

cas(null, 'connexion : plafond par compte, sans dépendre de l\'adresse annoncée ni fermer la porte au client', async ({ browser }) => {
  if (!/staging/.test(HUB_URL)) throw new NonAbouti('cas joué sur le Hub de staging seulement (essais de mot de passe)');
  const vue = await admin<{ cle?: string; source?: string }>('GET', 'ip-vue');
  if (vue.status !== 200) throw new NonAbouti(`ip-vue : HTTP ${vue.status}`);

  const A = await creerCompteProuve(browser, 'plafond');
  const premier = await essai(A.email, A.motDePasse, 1);
  expect(premier.status, 'entrée nominale').toBe(200);
  const cookie = premier.headers.getSetCookie().find((c) => c.includes('veridian-appareil='))?.split(';')[0];
  expect(cookie, 'navigateur reconnu après une entrée').toBeTruthy();

  const codes: number[] = [];
  for (let i = 0; i < ECHECS_MAX + 2; i++) {
    const cible = process.env.SSO_SABOTAGE === 'plafond' ? `e2e-sso-plafond-${i}@veridian.site` : A.email;
    codes.push((await essai(cible, 'mot-de-passe-faux', 10 + i)).status);
  }
  expect(codes, 'dix échecs, puis ralenti').toEqual([...Array(ECHECS_MAX).fill(401), 429, 429]);
  const inconnu = await essai(A.email, A.motDePasse, 99);
  expect(inconnu.status, 'bon mot de passe, navigateur inconnu, pendant l\'attaque').toBe(429);
  expect(Number(inconnu.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await essai(A.email, A.motDePasse, 98, cookie)).status, 'le client entre depuis son navigateur').toBe(200);
  expect((await essai('e2e-sso-plafond-autre@veridian.site', 'x', 97)).status, 'un autre compte n\'est pas touché').toBe(401);
  return `clé vue ${vue.json.source}, 10 échecs puis 429, navigateur connu 200, autre compte 401`;
}, { timeout: 300_000 });

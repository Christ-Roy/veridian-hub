/**
 * Ouvrir un client d'un coup (VER-263, Robert 25/11 : « tout faire comme propriétaire et me faire virer par ce dernier ») : sur une organisation jetable,
 * le chemin de `nouveau-client`, par l'API d'administration : les cinq apps ouvertes et relues, l'organisation réglée et cochée partout, l'administrateur
 * de plateforme y entre comme MEMBRE (le Hub n'ajoute jamais personne chez une app hors de ce chemin), puis il est désigné ADMIN dans chacune, relu,
 * jamais propriétaire. Rejouer ne change rien. Le propriétaire reste le seul propriétaire partout.
 * L'administrateur de plateforme est Robert (PLATFORM_ADMINS du job, public dans deploy/hub.nomad.hcl) : son compte passe par l'organisation jetable et en
 * sort avec elle au ménage de la batterie (suppression du tenant, espaces déprovisionnés). Prod seulement (le Hub de staging n'a pas toutes les apps).
 * Épreuve : `SSO_SABOTAGE=ouvrir-sans-membre` saute l'entrée comme membre : le cas doit échouer (« pas_membre » partout).
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { creerCompteProuve } from './lib/parcours';

const ADMIN_PLATEFORME = process.env.SSO_ADMIN_PLATEFORME || '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const APPS = ['notifuse', 'prospection', 'crm', 'academy', 'analytics'] as const;
type Json = any;

cas(null, 'ouvrir un client d\'un coup : cinq apps ouvertes et relues, l\'administrateur de plateforme admin dans chacune, jamais propriétaire', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (toutes les apps)');
  const P = await creerCompteProuve(browser, 'ouvrirclient');
  const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string } | undefined;
  if (!T) throw new NonAbouti('compte d\'essai sans organisation');
  await marquerTest(T.id);

  // 1. Les cinq apps, d'un geste, chacune relue.
  const o = await admin<Json>('POST', `tenants/${T.id}/ouvrir`, { apps: [...APPS] });
  const ouvertes = (o.json.apps as { app: string; etat: string; detail?: string }[]).map((a) => `${a.app}=${a.etat}${a.detail ? ` (${a.detail})` : ''}`);
  expect([o.status, o.json.verdict], `ouverture : ${ouvertes.join(', ')}`).toEqual([200, 'complet']);

  // 2. L'organisation réglée au Hub, cochée dans les cinq.
  const r = await admin<Json>('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: `TEST ouvrir ${Date.now().toString(36)}`, modules: [...APPS] });
  const emises = (r.json.emissions as { app: string; etat: string; detail?: string }[]).map((e) => `${e.app}=${e.etat}${e.detail ? ` (${e.detail})` : ''}`);
  expect((r.json.emissions as { etat: string }[]).every((e) => e.etat === 'applique'), `réglage : ${emises.join(', ')}`).toBe(true);

  // 3. L'administrateur de plateforme y entre comme membre (le chemin de nouveau-client).
  if (process.env.SSO_SABOTAGE !== 'ouvrir-sans-membre') {
    const m = await admin<Json>('POST', `tenants/${T.id}/members`, { hub_user_id: ADMIN_PLATEFORME });
    // 207 : une app n'a pas suivi le rôle (dit dans `organisation`) ; le membre, lui, est créé au Hub.
    expect([[200, 207].includes(m.status), m.json.cree === true || m.json.deja === true], JSON.stringify(m.json).slice(0, 300)).toEqual([true, true]);
  }

  // 4. Désigné admin dans chacune, relu ; jamais propriétaire. Rejouer ne change rien.
  const d1 = await adminOk<{ designations: { app: string; hubUserId: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/admins-plateforme`, { raison: 'épreuve VER-263 (organisation jetable)' });
  const moi = d1.designations.filter((x) => x.hubUserId === ADMIN_PLATEFORME);
  const vu = moi.map((x) => `${x.app}=${x.etat}${x.detail ? ` (${x.detail})` : ''}`).sort();
  expect(vu, 'admin relu dans les cinq apps').toEqual([...APPS].map((a) => `${a}=admin`).sort());
  const d2 = await adminOk<{ designations: { app: string; hubUserId: string; etat: string }[] }>('POST', `tenants/${T.id}/admins-plateforme`, { raison: 'rejeu' });
  expect(d2.designations.filter((x) => x.hubUserId === ADMIN_PLATEFORME).map((x) => `${x.app}=${x.etat}`).sort(), 'rejoué : rien ne change').toEqual(vu);
  return `ouvert d'un coup [${ouvertes.join(', ')}] ; réglé [${emises.join(', ')}] ; administrateur de plateforme : ${vu.join(', ')}`;
}, { timeout: 600_000 });

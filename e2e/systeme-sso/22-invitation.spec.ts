/**
 * Une invitation de Mail acceptée rend membre au Hub (VER-245), seulement si l'inviteur est propriétaire ou admin AU HUB.
 * L'appel est celui de Notifuse : signé par le secret d'invitation, inviteur désigné par hub_user_id. Comptes de test, prod.
 * Épreuve : `SSO_SABOTAGE=invitation` signe avec un autre secret : le cas doit échouer.
 */
import { createHmac } from 'node:crypto';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, secretDe } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, type Compte } from './lib/parcours';

const espaces = async (jeton: string): Promise<string[]> => JSON.parse((await outil(jeton, 'executer_outil', { nom: 'hub.mon_compte' })).texte).espaces.map((e: { slug: string }) => e.slug);

cas(null, 'invitation : acceptée, elle rend membre au Hub ; un simple membre n\'y fait entrer personne', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('le staging n\'a pas d\'espace Mail relié : se joue en prod');
  const secret = process.env.SSO_SABOTAGE === 'invitation' ? 'x'.repeat(64) : secretDe('HUB_INVITATION_SECRET_NOTIFUSE_PROD');
  const [P, M, X] = [await creerCompteProuve(browser, 'invprop'), await creerCompteProuve(browser, 'invmembre'), await creerCompteProuve(browser, 'invtiers')];
  // Un compte neuf n'a plus d'espace Mail tant qu'il ne l'ouvre pas : on l'ouvre par le chemin du Hub.
  const t0 = (await lookup(P.email)).json.tenants[0];
  const o = await adminOk<{ apps: { etat: string }[] }>('POST', `tenants/${t0.id}/ouvrir`, { apps: ['notifuse'] });
  if (o.apps[0]?.etat !== 'ouverte') throw new NonAbouti(`espace Mail du propriétaire : ${JSON.stringify(o.apps)}`);
  const t = (await lookup(P.email)).json.tenants[0];
  const creer = async (de: Compte, a: Compte, espace = t.notifuseWorkspaceSlug as string) => {
    const corps = JSON.stringify({ inviter_user_id: de.hubUserId, inviter_email: de.email, invitee_email: a.email, target_app: 'notifuse', target_workspace_id: espace, target_role: 'member' });
    const ts = String(Date.now());
    const r = await fetch(`${HUB_URL}/api/invitations/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-veridian-app': 'notifuse', 'x-veridian-timestamp': ts, 'x-veridian-invitation-signature': createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex') },
      body: corps,
    });
    const j = await r.json().catch(() => null);
    return { status: r.status, json: j };
  };
  const inviter = async (de: Compte, a: Compte) => {
    const { status, json } = await creer(de, a);
    if (status !== 201) throw new Error(`création : HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
    return String(json.token);
  };
  const accepter = async (qui: Compte, token: string) => {
    const ctx = await browser.newContext({ storageState: qui.etat as never });
    try {
      const r = await ctx.request.post(`${HUB_URL}/api/invitations/${token}/accept`, { data: {}, headers: { origin: HUB_URL } });
      return { status: r.status(), json: await r.json().catch(() => null) };
    } finally {
      await ctx.close();
    }
  };
  const jetonM = await obtenirJetonMcp(browser, M, 'TEST INVITATION M');
  expect(await espaces(jetonM), 'avant').not.toContain(t.slug);

  const m = await accepter(M, await inviter(P, M));
  expect([m.status, m.json?.downstream_call], JSON.stringify(m.json).slice(0, 200)).toEqual([200, 'completed']);
  expect(await espaces(jetonM), 'membre au Hub').toContain(t.slug);

  // M est simple membre au Hub : il n'invite personne. Et un espace non relié n'accueille personne : le Hub ne pourrait pas le couper.
  const parMembre = await creer(M, X);
  expect([parMembre.status, parMembre.json?.error], JSON.stringify(parMembre.json)).toEqual([403, 'inviteur_non_habilite']);
  const ailleurs = await creer(P, X, 'espace-inexistant');
  expect([ailleurs.status, ailleurs.json?.error], JSON.stringify(ailleurs.json)).toEqual([409, 'espace_non_relie']);

  // Retrait : une invitation en attente ne le ramène pas.
  const enAttente = await inviter(P, M);
  const retrait = await admin<any>('POST', `tenants/${t.id}/remove-member`, { hub_user_id: M.hubUserId });
  expect([200, 207], JSON.stringify(retrait.json).slice(0, 300)).toContain(retrait.status);
  expect(retrait.json.apps.find((a: { app: string }) => a.app === 'notifuse')?.etat, JSON.stringify(retrait.json.apps)).toBe('retire');
  expect((await accepter(M, enAttente)).status, 'invitation expirée par le retrait').toBe(410);
  expect(await espaces(jetonM), 'retiré').not.toContain(t.slug);
  return `membre par invitation, invitation d'un simple membre 403, espace non relié 409, retrait ${retrait.json.apps.map((a: { app: string; etat: string }) => `${a.app}=${a.etat}`).join(' ')}, invitation en attente expirée`;
}, { timeout: 420_000 });

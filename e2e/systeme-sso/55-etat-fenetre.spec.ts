/**
 * Quand une app montre la fenêtre de l'assistant (CONTRAT-HUB §5.24.1, parente 26/11 : une fenêtre qui refuse tout le monde ne s'affiche
 * jamais). Signé comme Prospection, `POST /api/ia/etat` dit l'état pour un compte d'essai neuf : sans moteur d'abord, puis une clé branchée
 * (modèle gratuit, 0 $), puis l'assistant éteint pour l'app ; une organisation qui n'est pas la sienne rend 404 ; un appel rejoué, 401.
 * La fenêtre servie dit la même chose : sans moteur, le renvoi « Relier mon IA » et aucune saisie ; avec la clé, la saisie.
 * Épreuve : `SSO_SABOTAGE=etat-force` attend « prete » avant toute clé : le cas doit échouer.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { secretDe } from './lib/hub-admin';
import { contexteDe } from './lib/monde';
import { creerCompteProuve } from './lib/parcours';

const MODELE_GRATUIT = 'nvidia/nemotron-3-ultra-550b-a55b:free';

/** L'appel de Prospection au Hub, signé : renvoie le statut et le corps lu. `rejouer` renvoie le même nonce deux fois. */
async function etat(hubUserId: string, tenantId: string, nonceFixe?: string): Promise<{ statut: number; etat?: string; error?: string }> {
  const corps = JSON.stringify({ hub_user_id: hubUserId, tenant_id: tenantId });
  const ts = String(Date.now());
  const nonce = nonceFixe ?? randomBytes(18).toString('base64url');
  // vers-le-hub : appel d app signé (ts.nonce.corps) vers /api/ia/etat, vérifié par le Hub (verifierAppel).
  const signature = createHmac('sha256', secretDe('PROSPECTION_TENANT_API_SECRET')).update(`${ts}.${nonce}.${corps}`).digest('hex');
  const r = await fetch(`${HUB_URL}/api/ia/etat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-veridian-app': 'prospection', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': signature },
    body: corps,
  });
  return { statut: r.status, ...(((await r.json().catch(() => ({}))) as { etat?: string; error?: string }) ?? {}) };
}

cas(null, 'Mon IA : l\'app ne montre la fenêtre que si elle peut répondre (POST /api/ia/etat, signé)', async ({ browser }) => {
  const E = await creerCompteProuve(browser, 'etatia');
  if (!E.tenantId || !E.hubUserId) throw new NonAbouti('compte d\'essai sans organisation ou sans identifiant Hub');
  const ctx = await contexteDe(browser, E);
  const api = ctx.request;
  const fenetre = `${HUB_URL}/ia/chat?app=prospection&tenant=${E.tenantId}`;
  try {
    // 1. Sans moteur : l'app montre la carte, jamais la fenêtre ; la fenêtre ouverte quand même ne propose aucune saisie.
    const sans = await etat(E.hubUserId, E.tenantId);
    if (process.env.SSO_SABOTAGE === 'etat-force') expect(sans.etat, 'épreuve : « prete » attendu sans moteur').toBe('prete');
    expect(sans, 'sans moteur').toEqual({ statut: 200, etat: 'sans_moteur' });
    const p1 = await ctx.newPage();
    await p1.goto(fenetre, { waitUntil: 'networkidle' });
    await expect(p1.locator('[data-refus="sans_moteur"]'), 'fenêtre sans moteur : le renvoi au connecteur').toContainText('Relier mon IA');
    expect(await p1.getByLabel('Votre question').count(), 'fenêtre sans moteur : aucune saisie').toBe(0);
    await p1.screenshot({ path: '.run/captures/etat-fenetre-sans-moteur.png' });
    await p1.close();

    // 2. Une organisation qui n'est pas la sienne, puis un nonce rejoué : rien n'est dit.
    const etrangere = await etat(E.hubUserId, randomUUID());
    const nonce = randomBytes(18).toString('base64url');
    await etat(E.hubUserId, E.tenantId, nonce);
    const rejoue = await etat(E.hubUserId, E.tenantId, nonce);
    expect([etrangere.statut, rejoue.statut], 'organisation étrangère : 404 ; nonce rejoué : 401').toEqual([404, 401]);

    // 3. Une clé branchée : « prete », et la fenêtre propose la discussion.
    const b = await api.post(`${HUB_URL}/api/ia/branchement`, { data: { fournisseur: 'openrouter', modele: MODELE_GRATUIT, cle: secretDe('OPENROUTER_API_KEY') } });
    if (b.status() !== 200) throw new NonAbouti(`branchement : HTTP ${b.status()}`);
    expect(await etat(E.hubUserId, E.tenantId), 'clé branchée').toEqual({ statut: 200, etat: 'prete' });
    const p2 = await ctx.newPage();
    await p2.goto(fenetre, { waitUntil: 'networkidle' });
    await expect(p2.getByLabel('Votre question'), 'fenêtre avec moteur : la saisie').toBeVisible({ timeout: 20_000 });
    await p2.screenshot({ path: '.run/captures/etat-fenetre-prete.png' });
    await p2.close();

    // 4. Éteinte pour Prospection : « eteinte », la fenêtre le dit.
    const off = await api.post(`${HUB_URL}/api/ia/activation`, { data: { app: 'prospection', tenantId: E.tenantId, enabled: false } });
    expect(off.status(), 'assistant éteint pour Prospection').toBe(200);
    expect(await etat(E.hubUserId, E.tenantId), 'éteinte').toEqual({ statut: 200, etat: 'eteinte' });
    return 'sans moteur : sans_moteur, fenêtre sans saisie avec « Relier mon IA » ; organisation étrangère 404, nonce rejoué 401 ; clé branchée : prete, saisie visible ; éteinte : eteinte';
  } finally {
    await api.post(`${HUB_URL}/api/ia/activation`, { data: { app: 'prospection', tenantId: E.tenantId, enabled: true } }).catch(() => undefined);
    await api.delete(`${HUB_URL}/api/ia/branchement?fournisseur=openrouter`).catch(() => undefined);
    await ctx.close();
  }
});

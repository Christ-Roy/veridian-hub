/**
 * Mon IA dans Prospection (VER-203 a, contrat §5.24) : le bouton « Mon IA » d'Atlas ouvre la fenêtre du Hub, l'IA branchée (modèle gratuit,
 * 0 $, comme la recette) répond par la porte MCP, et le fil se range CHEZ Prospection : le Hub le relit par GET /api/hub/ia/fils.
 * Compte d'essai ; le branchement et l'activation sont retirés à la fin.
 * Épreuve : `SSO_SABOTAGE=fil-autre-session` relit une autre session : le fil ne doit pas revenir, le cas doit échouer.
 */
import { randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { secretDe } from './lib/hub-admin';
import { contexteDe } from './lib/monde';
import { creerCompteProuve, ouvrirApp } from './lib/parcours';

const MODELE_GRATUIT = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // même modèle que la recette (0 $, vérifié le 22/11)

cas('prospection', 'Mon IA : la fenêtre du Hub dans Atlas, une question, et le fil rangé chez Prospection puis relu par le Hub', async ({ browser }) => {
  const E = await creerCompteProuve(browser, 'monia');
  if (!E.tenantId) throw new NonAbouti('compte d\'essai sans organisation');
  const cle = secretDe('OPENROUTER_API_KEY');
  const ctx = await contexteDe(browser, E);
  const api = ctx.request;
  try {
    await ouvrirApp(ctx, 'prospection');
    // 1. La fenêtre : le bouton « Mon IA » d'Atlas insère le cadre du Hub pour l'organisation.
    const page = await ctx.newPage();
    await page.goto(`${APP_URL.prospection}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Plus tard$/ }).click({ timeout: 5_000 }).catch(() => {});
    await page.getByRole('button', { name: /Mon IA/ }).first().click({ timeout: 20_000 });
    const cadre = page.locator(`iframe[src^="${HUB_URL}/ia/chat"]`).first();
    await cadre.waitFor({ timeout: 30_000 });
    const src = (await cadre.getAttribute('src')) ?? '';
    expect(new URL(src).searchParams.get('app'), 'cadre ouvert pour Prospection').toBe('prospection');
    expect(new URL(src).searchParams.get('tenant'), 'cadre ouvert pour l\'organisation du compte').toBe(E.tenantId);
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: '.run/captures/mon-ia-prospection.png' });
    await page.close();

    // 2. L'IA branchée (modèle gratuit), puis une question par le chemin de la fenêtre.
    const b = await api.post(`${HUB_URL}/api/ia/branchement`, { data: { fournisseur: 'openrouter', modele: MODELE_GRATUIT, cle } });
    if (b.status() !== 200) throw new NonAbouti(`branchement : HTTP ${b.status()}`);
    const question = { app: 'prospection', tenantId: E.tenantId, messages: [{ id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Quels sont mes plans Veridian ? Utilise hub.mon_compte par les outils, puis réponds en une phrase.' }] }] };
    const c = await api.post(`${HUB_URL}/api/ia/chat`, { data: question, timeout: 120_000 });
    const flux = await c.text();
    if (c.status() === 429) throw new NonAbouti('plafond du fournisseur gratuit atteint : chat non joué');
    expect(c.status(), flux.slice(0, 160)).toBe(200);
    expect(flux.includes(cle), 'la clé ne paraît jamais dans le flux').toBe(false);
    const session = /"sessionId":"([0-9a-f-]{36})"/.exec(flux)?.[1];
    expect(session, 'le Hub rend la session du fil').toBeTruthy();

    // 3. Le fil, rangé chez Prospection à la fin du tour, relu par le Hub (GET <prospection>/api/hub/ia/fils/:session).
    const lue = process.env.SSO_SABOTAGE === 'fil-autre-session' ? randomUUID() : session!;
    let messages: unknown[] = [];
    for (let i = 0; i < 10 && messages.length === 0; i++) {
      const f = await api.get(`${HUB_URL}/api/ia/fil?app=prospection&session=${lue}&tenant=${E.tenantId}`);
      messages = f.status() === 200 ? (((await f.json().catch(() => null)) as { messages?: unknown[] } | null)?.messages ?? []) : [];
      if (!messages.length) await new Promise((ok) => setTimeout(ok, 2_000));
    }
    expect(messages.length, 'le fil relu chez Prospection contient la question et la réponse').toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(messages), 'la question posée se retrouve dans le fil rangé').toContain('Quels sont mes plans Veridian');
    return `cadre ${HUB_URL}/ia/chat?app=prospection ouvert par « Mon IA » d'Atlas ; réponse 200 par la porte, clé absente du flux ; fil de ${messages.length} message(s) rangé chez Prospection et relu par le Hub`;
  } finally {
    await api.post(`${HUB_URL}/api/ia/activation`, { data: { app: 'prospection', tenantId: E.tenantId, enabled: false } }).catch(() => undefined);
    await api.delete(`${HUB_URL}/api/ia/branchement?fournisseur=openrouter`).catch(() => undefined);
    await ctx.close();
  }
});

/**
 * Témoin : le compte de test ne voit aucune donnée d'un autre tenant.
 * Un deuxième compte de test (B) fournit la présence qui rend l'absence probante.
 */
import { expect } from '@playwright/test';

import { devraitIgnorerLesAutres } from './lib/assertions';
import { APP_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { listTenants } from './lib/hub-admin';
import { compte, contexteDe, ouvrirApp } from './lib/monde';

/** Marques de tenants qui ne sont pas à nous : on n'en garde que la forme, jamais l'affichage. */
async function marquesEtrangeres(nosEmails: string[]) {
  const l = await listTenants();
  const marques = new Set<string>();
  for (const t of l.tenants ?? []) {
    const e = String(t.email ?? '').toLowerCase();
    if (!e || nosEmails.includes(e) || e.startsWith('e2e-')) continue;
    marques.add(e);
    for (const k of ['slug', 'notifuseWorkspaceSlug']) if (t[k] && String(t[k]).length > 5) marques.add(String(t[k]));
  }
  return [...marques];
}

cas('prospection', 'le compte de test ne voit aucune donnée d\'un autre tenant', async ({ browser }) => {
  const [A, B] = [await compte(browser, 'A'), await compte(browser, 'B')];
  const cA = await contexteDe(browser, A);
  const cB = await contexteDe(browser, B);
  try {
    await ouvrirApp(cA, 'prospection');
    await ouvrirApp(cB, 'prospection');
    const meA = await (await cA.request.get(`${APP_URL.prospection}/api/me`)).json();
    const meB = await (await cB.request.get(`${APP_URL.prospection}/api/me`)).json();
    expect(meB?.tenantId, 'témoin : B a son propre tenant').toBeTruthy();
    expect(meA.tenantId, 'A et B ont des tenants distincts').not.toBe(meB.tenantId);
    const idsA = new Set((meA.workspaces ?? []).map((w: any) => w.id));
    for (const w of meB.workspaces ?? []) expect(idsA.has(w.id), 'espace de B visible par A').toBe(false);
    const corps = JSON.stringify(meA);
    devraitIgnorerLesAutres(corps, [B.email, String(meB.tenantId), ...(meB.workspaces ?? []).map((w: any) => w.id)], 'Prospection /api/me');
    // l'espace de B demandé explicitement par A ne s'ouvre pas
    const wsB = meB.workspaces?.[0]?.id;
    if (wsB) {
      const r = await cA.request.get(`${APP_URL.prospection}/api/workspaces/${wsB}`);
      expect([401, 403, 404, 405], `A lit l'espace de B (HTTP ${r.status()})`).toContain(r.status());
    }
    return 'tenants et espaces disjoints, espace de B refusé à A';
  } finally {
    await cA.close();
    await cB.close();
  }
});

cas('notifuse', 'le compte de test ne voit aucune donnée d\'un autre tenant', async ({ browser }) => {
  const [A, B] = [await compte(browser, 'A'), await compte(browser, 'B')];
  const cA = await contexteDe(browser, A);
  const cB = await contexteDe(browser, B);
  try {
    const a = await ouvrirApp(cA, 'notifuse');
    const b = await ouvrirApp(cB, 'notifuse');
    expect(b.texte, 'témoin : la console de B montre B').toContain(B.email);
    expect(a.texte, 'la console de A montre A').toContain(A.email);
    const etrangers = await marquesEtrangeres([A.email, B.email]);
    if (etrangers.length < 3) throw new NonAbouti('moins de 3 autres tenants dans le Hub : témoin d\'absence trop mince');
    devraitIgnorerLesAutres(a.texte, [B.email, ...etrangers], 'Notifuse console de A');
    // A demande la console du workspace de B
    const slugB = B.email.replace(/^e2e-sso-/, '').split('@')[0].replace(/[^a-z0-9]/gi, '');
    const p = await cA.newPage();
    await p.goto(`${APP_URL.notifuse}/console/workspace/${slugB}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await p.waitForTimeout(1500);
    const t = (await p.locator('body').innerText().catch(() => '')).toLowerCase();
    await p.close();
    expect(t.includes(B.email.toLowerCase()), 'A voit l\'adresse de B dans le workspace de B').toBe(false);
    return `console de A : aucune des ${etrangers.length} marques étrangères ni B`;
  } finally {
    await cA.close();
    await cB.close();
  }
});

cas('analytics', 'le compte de test ne voit aucune donnée d\'un autre tenant', async ({ browser }) => {
  const [A, B] = [await compte(browser, 'A'), await compte(browser, 'B')];
  const cA = await contexteDe(browser, A);
  try {
    const a = await ouvrirApp(cA, 'analytics');
    if (new URL(APP_URL.analytics).host !== a.hote) {
      throw new Error(`Rybbit : A n'arrive pas dans l'app (fin sur ${a.hote}${a.chemin}), l'isolation ne peut pas être observée`);
    }
    devraitIgnorerLesAutres(a.texte, [B.email, ...(await marquesEtrangeres([A.email, B.email]))], 'Rybbit pour A');
    return 'aucune marque étrangère dans la vue de A';
  } finally {
    await cA.close();
  }
});

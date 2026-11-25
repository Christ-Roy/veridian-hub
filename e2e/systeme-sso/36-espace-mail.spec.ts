/**
 * L'espace Mail de chacun (25/11) : deux adresses au même début ont chacune le leur ; un provisionnement rejoué rend le même ; deux provisionnements qui
 * se croisent n'en font qu'un, et un seul tenant. Vu échouer avant le correctif (v160) : le second compte n'avait jamais d'espace.
 */
import { createHmac } from 'node:crypto';

import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { lookup, secretDe } from './lib/hub-admin';
import { creerCompteProuve, noterWorkspace, type Compte } from './lib/parcours';

cas(null, 'espace Mail : chacun le sien, au même début d\'adresse, rejoué, et en course', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('le Hub de staging n\'a pas Mail en face');
  const tenants = async (c: Compte) => (((await lookup(c.email)).json?.tenants ?? []) as { id: string; notifuseWorkspaceSlug?: string | null }[]);
  const avec = async <R>(etat: unknown, f: (ctx: BrowserContext) => Promise<R>): Promise<R> => { const ctx = await browser.newContext({ storageState: etat as never }); try { return await f(ctx); } finally { await ctx.close(); } };
  const commencer = (c: Compte) => avec(c.etat, async (ctx) => { const r = await ctx.request.post(`${HUB_URL}/api/tenants/start`, { data: { app: 'notifuse' }, timeout: 120_000 }); return [r.status(), (await r.json().catch(() => null)) as { already_provisioned?: boolean } | null] as const; });
  /** Les espaces où Mail voit cette personne. */
  const chezMail = async (c: Compte) => {
    const ts = String(Date.now());
    const r = await fetch(`${APP_URL.notifuse}/api/users/by-email?email=${encodeURIComponent(c.email)}&hub_user_id=${c.hubUserId}`, { headers: { 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', secretDe('NOTIFUSE_HUB_API_SECRET')).update(`${ts}.`).digest('hex') }, signal: AbortSignal.timeout(30_000) });
    return (((await r.json().catch(() => null)) as { workspaces?: { workspace_id: string }[] } | null)?.workspaces ?? []).map((w) => w.workspace_id);
  };
  // Même début : les 20 premiers caractères utiles de l'adresse sont identiques.
  const [A, B]: Compte[] = [await creerCompteProuve(browser, 'memedebut1', undefined, true), await creerCompteProuve(browser, 'memedebut2', undefined, true)];
  const debut = (c: Compte) => c.email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 20);
  expect(debut(A), 'l\'épreuve porte bien sur le même début').toBe(debut(B));
  const espaceDe = async (c: Compte) => {
    const [s] = await commencer(c);
    const [t] = await tenants(c);
    if (t?.notifuseWorkspaceSlug) noterWorkspace(c.email, t.notifuseWorkspaceSlug);
    return { statut: s, slug: t?.notifuseWorkspaceSlug ?? null, mail: await chezMail(c) };
  };
  const [a, b] = [await espaceDe(A), await espaceDe(B)];
  expect([a.statut, a.mail, b.statut, b.mail], JSON.stringify({ a, b })).toEqual([200, [a.slug], 200, [b.slug]]);
  expect([a.slug !== null, b.slug !== null, a.slug !== b.slug, a.slug?.includes('memedebut')], 'chacun le sien').toEqual([true, true, true, false]);

  // Rejoué : le même, et rien de plus.
  expect((await commencer(A))[1]?.already_provisioned).toBe(true);
  expect([(await tenants(A)).map((t) => t.notifuseWorkspaceSlug), await chezMail(A)]).toEqual([[a.slug], [a.slug]]);

  // Course : quatre départs d'un compte sans tenant.
  const C: Compte = await creerCompteProuve(browser, 'memedebut3', undefined, true);
  expect(await tenants(C), 'contrôle : rien avant').toEqual([]);
  const departs = await Promise.all([1, 2, 3, 4].map(() => commencer(C)));
  const tc = await tenants(C);
  for (const t of tc) if (t.notifuseWorkspaceSlug) noterWorkspace(C.email, t.notifuseWorkspaceSlug);
  expect([tc.length, await chezMail(C)], `départs ${departs.map(([s]) => s).join(' ')}`).toEqual([1, [tc[0]?.notifuseWorkspaceSlug]]);
  expect((await commencer(C))[1]?.already_provisioned, 'et il est noté').toBe(true);
  return `deux adresses au même début : deux espaces ; rejoué : le même ; quatre départs croisés (${departs.map(([s]) => s).join(' ')}) : un tenant, un espace`;
}, { timeout: 600_000 });

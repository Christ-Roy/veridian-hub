/**
 * Analytics vu de la batterie (VER-260) : l'opérateur Veridian prépare une organisation de TEST, son site et ses comptes, par l'API de l'app. Adresses
 * e2e-sso-* seulement. Aucun secret affiché : la session de l'opérateur reste en mémoire.
 */
import { randomBytes } from 'node:crypto';

import { request, type APIRequestContext } from '@playwright/test';

import { APP_URL } from './cibles';
import { NonAbouti } from './etat';
import { secretDe } from './hub-admin';

const A = APP_URL.analytics;
const EPREUVE = /^e2e-sso-[a-z0-9-]+@veridian\.site$/;
type Json = any;

export async function operateur(): Promise<APIRequestContext> {
  const ctx = await request.newContext({ extraHTTPHeaders: { Origin: A } });
  // La connexion de l'opérateur est bornée (429) : on patiente, ce n'est pas l'objet testé.
  for (const attente of [0, 45_000, 90_000]) {
    await new Promise((ok) => setTimeout(ok, attente));
    const r = await ctx.post(`${A}/api/auth/sign-in/email`, { data: { email: secretDe('RYBBIT_PROD_UI_EMAIL'), password: secretDe('RYBBIT_PROD_UI_PASSWORD') } });
    if (r.status() === 200) return ctx;
    if (r.status() !== 429) throw new NonAbouti(`Analytics : connexion de l'opérateur HTTP ${r.status()}`);
  }
  throw new NonAbouti('Analytics : connexion de l\'opérateur bornée (429)');
}

/** L'organisation de test d'un compte d'épreuve, telle que compte-e2e-rybbit.sh la nomme. */
export async function organisationDe(op: APIRequestContext, email: string): Promise<string> {
  const slug = `e2esso-${email.replace(/^e2e-sso-([a-z0-9-]+)@.*/, '$1').slice(0, 40)}`;
  const j = (await (await op.get(`${A}/api/organizations`)).json().catch(() => null)) as Json;
  const id = ((Array.isArray(j) ? j : (j?.data ?? j?.organizations ?? [])) as { id: string; slug: string }[]).find((o) => o.slug === slug)?.id;
  if (!id) throw new NonAbouti(`Analytics : organisation ${slug} introuvable`);
  return id;
}

/** Un compte d'épreuve, simple membre de cette organisation ; son mot de passe est perdu, il entrera par le Hub. */
export async function membreDe(op: APIRequestContext, org: string, email: string): Promise<void> {
  if (!EPREUVE.test(email)) throw new NonAbouti('adresse hors épreuve');
  const r = await op.post(`${A}/api/organizations/${org}/users`, { data: { email, password: randomBytes(18).toString('base64'), name: 'TEST e2e-sso', role: 'member' } });
  if (r.status() !== 201) throw new NonAbouti(`Analytics : membre non créé, HTTP ${r.status()} ${(await r.text()).slice(0, 120)}`);
}

export async function siteDe(op: APIRequestContext, org: string, domaine: string): Promise<{ siteId: number; cleSuivi: string }> {
  const r = await op.post(`${A}/api/organizations/${org}/sites`, {
    // Le bastion est une adresse d'hébergeur : le filtre à robots écarterait la visite d'épreuve. Réglage de CE site de test.
    data: { domain: domaine, name: `TEST ${domaine}`, blockBots: false },
  });
  const j = (await r.json().catch(() => null)) as Json;
  const siteId = Number(j?.siteId ?? j?.site_id ?? j?.data?.siteId);
  if (!siteId) throw new NonAbouti(`Analytics : site non créé, HTTP ${r.status()} ${JSON.stringify(j).slice(0, 160)}`);
  return { siteId, cleSuivi: String(j?.id ?? j?.data?.id ?? siteId) };
}

/** Une visite, comme la pose le script de suivi dans un navigateur. */
export async function visite(cleSuivi: string, domaine: string, chemin: string): Promise<number> {
  const r = await fetch(`${A}/api/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'accept-language': 'fr-FR,fr;q=0.9', accept: '*/*', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: `https://${domaine}` },
    body: JSON.stringify({ type: 'pageview', site_id: cleSuivi, hostname: domaine, pathname: chemin, querystring: '', screenWidth: 1920, screenHeight: 1080, language: 'fr-FR', page_title: 'TEST', referrer: '' }),
    signal: AbortSignal.timeout(20_000),
  });
  return r.status;
}

const JOUR = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const DEMAIN = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
export const apercu = (siteId: number) => `${A}/api/sites/${siteId}/overview?start_date=${JOUR()}&end_date=${DEMAIN()}&time_zone=UTC&filters=%5B%5D`;
export async function pagesVues(ctx: APIRequestContext, siteId: number): Promise<number | null> {
  const r = await ctx.get(apercu(siteId), { timeout: 20_000 });
  return r.ok() ? Number(((await r.json().catch(() => null)) as Json)?.data?.pageviews ?? Number.NaN) : null;
}

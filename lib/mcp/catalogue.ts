/**
 * Catalogue d'un utilisateur : les outils du Hub, plus ceux que chaque app inscrite au registre
 * (`mcp_apps`) lui rend par `tools/list`. Le Hub ne connaît aucun outil d'app : il les relit
 * (cache 5 min par app et par utilisateur) et les nomme `<app>.<outil>`.
 */
import type { PrismaClient } from '@prisma/client';

import { AppInjoignable, SessionApp, type OutilApp } from './client-app';
import { signerPourApp } from './identite';
import type { Appelant } from './oauth';

export type Db = Pick<PrismaClient, 'mcpApp' | 'tenantApp' | 'tenant' | 'tenantTrial'>;

export type Outil = {
  nom: string;
  app: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  /** Nom de l'outil chez l'app. */
  local: string;
};

export type AppInscrite = { appKey: string; label: string; mcpUrl: string };

export type Deps = { fetchImpl?: typeof fetch; maintenant?: () => number };

const TTL_MS = 5 * 60_000;
const ECHEC_TTL_MS = 60_000;
const cache = new Map<string, { a: number; outils: Outil[] }>();
/** Une app en panne n'est pas réinterrogée pendant 1 min : sinon chaque appel attendrait son délai. */
const echecs = new Map<string, { a: number; raison: string }>();

export function viderCache() {
  cache.clear();
  echecs.clear();
}

/** Apps du registre ouvertes à cet utilisateur. */
export async function appsDe(db: Db, hubUserId: string): Promise<AppInscrite[]> {
  const apps = await db.mcpApp.findMany({ where: { enabled: true }, orderBy: { appKey: 'asc' } });
  const besoinActivation = apps.filter((a) => a.acces !== 'tous').map((a) => a.appKey);
  const actives = besoinActivation.length
    ? new Set(
        (
          await db.tenantApp.findMany({
            where: { userId: hubUserId, enabled: true, appKey: { in: besoinActivation } },
            select: { appKey: true },
          })
        ).map((r) => r.appKey),
      )
    : new Set<string>();
  return apps
    .filter((a) => a.acces === 'tous' || actives.has(a.appKey))
    .map((a) => ({ appKey: a.appKey, label: a.label, mcpUrl: a.mcpUrl }));
}

export async function sessionPour(app: AppInscrite, qui: Appelant, deps: Deps = {}): Promise<SessionApp> {
  const jeton = await signerPourApp({
    audience: app.mcpUrl,
    hubUserId: qui.hubUserId,
    email: qui.email,
    clientId: qui.clientId,
    scope: qui.scope,
  });
  const s = new SessionApp(app.mcpUrl, jeton, deps.fetchImpl);
  await s.ouvrir();
  return s;
}

function versOutil(app: string, o: OutilApp): Outil {
  const description = (o.description ?? o.title ?? '').split('\n')[0].slice(0, 300);
  return { nom: `${app}.${o.name}`, app, local: o.name, description, inputSchema: o.inputSchema ?? { type: 'object' }, annotations: o.annotations };
}

export async function outilsApp(app: AppInscrite, qui: Appelant, deps: Deps = {}): Promise<Outil[]> {
  const cle = `${app.appKey}:${qui.hubUserId}`;
  const now = (deps.maintenant ?? Date.now)();
  const c = cache.get(cle);
  if (c && now - c.a < TTL_MS) return c.outils;
  const e = echecs.get(app.appKey);
  if (e && now - e.a < ECHEC_TTL_MS) throw new AppInjoignable(e.raison);
  try {
    const s = await sessionPour(app, qui, deps);
    const outils = (await s.outils()).filter((o) => typeof o?.name === 'string').map((o) => versOutil(app.appKey, o));
    cache.set(cle, { a: now, outils });
    return outils;
  } catch (err) {
    const raison = err instanceof AppInjoignable ? err.message : 'erreur';
    // Un refus d'identité est propre à l'utilisateur : seule une panne de l'app est mémorisée.
    if (!/refuse l'identité/.test(raison)) echecs.set(app.appKey, { a: now, raison });
    throw err instanceof AppInjoignable ? err : new AppInjoignable(raison);
  }
}

export type Catalogue = { outils: Outil[]; apps: AppInscrite[]; injoignables: { app: string; raison: string }[] };

export async function catalogue(db: Db, qui: Appelant, outilsHub: Outil[], deps: Deps = {}): Promise<Catalogue> {
  const apps = await appsDe(db, qui.hubUserId);
  const res = await Promise.allSettled(apps.map((a) => outilsApp(a, qui, deps)));
  const outils = [...outilsHub];
  const injoignables: Catalogue['injoignables'] = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') outils.push(...r.value);
    else injoignables.push({ app: apps[i].appKey, raison: r.reason instanceof Error ? r.reason.message : 'erreur' });
  });
  return { outils, apps, injoignables };
}

const VIDES = new Set(['de', 'du', 'la', 'le', 'les', 'des', 'un', 'une', 'et', 'ou', 'pour', 'mes', 'mon', 'ma', 'a', 'à', 'en', 'sur', 'the', 'of', 'to', 'a', 'my', 'and']);

function mots(t: string): string[] {
  return t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length > 1 && !VIDES.has(m));
}

/** Recherche par mots (nom pèse plus que description). Sans besoin : les premiers outils de chaque app. */
export function chercher(outils: Outil[], besoin: string, app?: string, max = 10): Outil[] {
  const pool = app ? outils.filter((o) => o.app === app) : outils;
  const q = mots(besoin);
  if (q.length === 0) return pool.slice(0, max);
  const notes = pool.map((o) => {
    const nom = mots(o.nom.replace(/[._]/g, ' ')).join(' ');
    const desc = mots(o.description).join(' ');
    let n = 0;
    for (const m of q) {
      const racine = m.length > 4 ? m.slice(0, m.length - 1) : m;
      if (nom.includes(racine)) n += 3;
      if (desc.includes(racine)) n += 1;
    }
    return { o, n };
  });
  return notes
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((x) => x.o);
}

/** Envoie le document d'organisation à chaque app cochée, et note ce qu'elle en a fait, relu. Une app en panne n'empêche pas les autres. */
import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { hubPublicUrl } from '@/lib/organisations/base';

import { documentOrg, MODULES, pourApp, type Module } from './document';

const DELAI_MS = 15_000;
export type Emission = { app: Module; version: number; etat: 'applique' | 'non_relu' | 'ignore' | 'echec'; detail?: string };
type Db = Pick<PrismaClient, 'organisation' | 'organisationEmission' | 'tenant' | 'tenantMember' | 'user'>;
type Deps = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };

async function signer(app: Module, methode: 'GET' | 'POST', chemin: string, corps: string, deps: Deps): Promise<Response> {
  const c = resolveAppConfig(app, deps.env ?? process.env);
  if (!c) throw new Error(`${app}_not_configured`);
  const ts = String(Date.now());
  return (deps.fetchImpl ?? fetch)(`${c.apiUrl}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', c.hubSecret).update(`${ts}.${corps}`).digest('hex') },
    ...(methode === 'POST' ? { body: corps } : {}),
    signal: AbortSignal.timeout(DELAI_MS),
  });
}

/** Le document est appliqué, mais des membres ont été refusés : l'app le compte (trois noms, lus dans leur code le 25/11), on ne le tait pas. */
function membresRefuses(j: object): string | null {
  const r = j as { membres_refuses?: unknown; refused?: unknown; refuses?: unknown };
  const n = [r.membres_refuses, r.refused, r.refuses].find((x) => typeof x === 'number' && x > 0);
  return n ? `${n} membre(s) refusé(s) par l'app` : null;
}

async function versApp(app: Module, d: NonNullable<Awaited<ReturnType<typeof documentOrg>>>, deps: Deps): Promise<Emission> {
  try {
    const res = await signer(app, 'POST', '/api/hub/organisations/sync', JSON.stringify(pourApp(d, app)), deps);
    const j = (await res.json().catch(() => null)) as { applied?: boolean; reason?: string; error?: string } | null;
    if (!res.ok || typeof j?.applied !== 'boolean') return { app, version: d.version, etat: 'echec', detail: j?.error ?? `http_${res.status}` };
    if (!j.applied && j.reason !== 'unchanged') return { app, version: d.version, etat: 'ignore', detail: j.reason ?? 'raison absente' };
    const refus = membresRefuses(j);
    // « Appliqué » veut dire relu : la version que l'app SERT. Sans route de relecture, c'est dit.
    const relu = await signer(app, 'GET', `/api/hub/organisations/sync?hub_tenant_id=${encodeURIComponent(d.hub_tenant_id)}`, '', deps);
    const v = relu.ok ? ((await relu.json().catch(() => null)) as { version?: unknown } | null)?.version : undefined;
    if (v === undefined) return { app, version: d.version, etat: 'non_relu', detail: `relecture http_${relu.status}` };
    return Number(v) === d.version ? { app, version: d.version, etat: 'applique', ...(refus ? { detail: refus } : {}) } : { app, version: d.version, etat: 'echec', detail: `l'app sert la version ${String(v).slice(0, 20)}` };
  } catch (err) {
    return { app, version: d.version, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' };
  }
}

/** Émet vers les apps cochées. Rien si l'organisation n'est pas réglée au Hub. Rejouable : la version ne bouge que si le contenu bouge. */
export async function emettreOrganisation(db: Db, tenantId: string, deps: Deps = {}): Promise<Emission[]> {
  const d = await documentOrg(db, tenantId, hubPublicUrl(deps.env));
  if (!d) return [];
  const res = await Promise.all(MODULES.filter((m) => d.modules.includes(m)).map((m) => versApp(m, d, deps)));
  for (const e of res) {
    const ligne = { version: BigInt(e.version), etat: e.etat, detail: e.detail ?? null, le: new Date() };
    await db.organisationEmission.upsert({ where: { tenantId_app: { tenantId, app: e.app } }, create: { tenantId, app: e.app, ...ligne }, update: ligne });
  }
  return res;
}

/** Après un changement de membre : l'émission suit, sans jamais faire échouer le changement lui-même. */
export async function suivreOrganisation(db: Db, tenantId: string, deps: Deps = {}): Promise<Emission[]> {
  return emettreOrganisation(db, tenantId, deps).catch((err) => {
    console.error(JSON.stringify({ tag: '[organisation]', level: 'error', msg: 'émission impossible', tenant_id: tenantId, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
    return [];
  });
}

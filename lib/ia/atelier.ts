/**
 * Le Hub et l'atelier (moteur `claude-code-abonnement`, docs/MON-IA.md). Les deux sens sont signés avec
 * ATELIER_SECRET (HMAC sur `${ts}.${corps}`, en-tête X-Veridian-Atelier-Signature). L'atelier n'a aucun
 * autre secret ; le Hub reste le seul à joindre les apps.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MOTEUR_ABONNEMENT = 'claude-code-abonnement';
export const FOURNISSEUR_ABONNEMENT = 'claude-abonnement';

/** Adresse de l'atelier : ATELIER_URL, sinon le fichier que Nomad tient à jour (relu à chaque appel). */
function adresse(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ATELIER_URL) return env.ATELIER_URL;
  if (!env.ATELIER_URL_FICHIER) return undefined;
  try {
    return readFileSync(env.ATELIER_URL_FICHIER, 'utf8').split('\n').map((l) => l.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

function config(env: NodeJS.ProcessEnv = process.env) {
  const url = adresse(env)?.replace(/\/+$/, '');
  const secret = env.ATELIER_SECRET ?? '';
  return url && secret.length >= 32 ? { url, secret } : null;
}

export const atelierConfigure = (env?: NodeJS.ProcessEnv) => config(env) !== null;

/**
 * L'abonnement s'ouvre tenant par tenant (Robert, 23/11 : on n'attend plus Anthropic ; la limite est la capacité de
 * l'atelier, plus une autorisation). Fermé par défaut ; `hub ia atelier ouvrir|fermer <tenant>` pose
 * `metadata.ia_atelier.ouvert`, avec audit. Plafond : ATELIER_CAPACITE tenants ouverts (1 par défaut, faute
 * d'enfermement par processus sur nos nœuds, docs/MON-IA.md).
 */
type DbTenants = { tenant: { findUnique: (a: never) => Promise<{ metadata: unknown } | null>; findMany: (a: never) => Promise<{ id: string; metadata: unknown }[]> } };

export const ouvertDans = (metadata: unknown): boolean =>
  (metadata as { ia_atelier?: { ouvert?: unknown } } | null)?.ia_atelier?.ouvert === true;

export async function atelierOuvertPourTenant(db: DbTenants, tenantId: string): Promise<boolean> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { metadata: true } } as never);
  return ouvertDans(t?.metadata);
}

/** Le compte a-t-il au moins un espace où l'abonnement est ouvert ? (brancher, carte du tableau de bord) */
export async function abonnementOuvertCompte(db: DbTenants, hubUserId: string): Promise<boolean> {
  const lignes = await db.tenant.findMany({ where: { userId: hubUserId, deletedAt: null }, select: { id: true, metadata: true } } as never);
  return lignes.some((l) => ouvertDans(l.metadata));
}

export function capaciteAtelier(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ATELIER_CAPACITE ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

export async function appelerAtelier(chemin: string, corps: object, opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Response> {
  const c = config(opts.env);
  if (!c) throw new Error('atelier_non_configure');
  const brut = JSON.stringify(corps);
  const ts = String(Date.now());
  const sig = createHmac('sha256', c.secret).update(`${ts}.${brut}`).digest('hex');
  return fetch(`${c.url}${chemin}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Atelier-Signature': sig },
    body: brut,
    signal: opts.signal ?? AbortSignal.timeout(180_000),
  });
}

/** L'appel vient-il de l'atelier ? Signature valide et horodatage à moins de 5 minutes. */
export function vientDeLAtelier(headers: Headers, brut: string, env: NodeJS.ProcessEnv = process.env, maintenant = Date.now()): boolean {
  const c = config(env);
  const ts = headers.get('x-veridian-timestamp') ?? '';
  const sig = (headers.get('x-veridian-atelier-signature') ?? '').toLowerCase();
  if (!c || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(maintenant - tsMs) > 5 * 60_000) return false;
  const attendu = Buffer.from(createHmac('sha256', c.secret).update(`${ts}.${brut}`).digest('hex'));
  const recu = Buffer.from(sig);
  return attendu.length === recu.length && timingSafeEqual(attendu, recu);
}

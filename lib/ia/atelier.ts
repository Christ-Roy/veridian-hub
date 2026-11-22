/**
 * Le Hub et l'atelier (moteur `claude-code-abonnement`, docs/MON-IA.md). Les deux sens sont signés avec
 * ATELIER_SECRET (HMAC sur `${ts}.${corps}`, en-tête X-Veridian-Atelier-Signature). L'atelier n'a aucun
 * autre secret ; le Hub reste le seul à joindre les apps.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MOTEUR_ABONNEMENT = 'claude-code-abonnement';
export const FOURNISSEUR_ABONNEMENT = 'claude-abonnement';

function config(env: NodeJS.ProcessEnv = process.env) {
  const url = env.ATELIER_URL?.replace(/\/+$/, '');
  const secret = env.ATELIER_SECRET ?? '';
  return url && secret.length >= 32 ? { url, secret } : null;
}

export const atelierConfigure = (env?: NodeJS.ProcessEnv) => config(env) !== null;

/**
 * Comptes autorisés à brancher leur abonnement (Robert seul tant qu'Anthropic n'a pas confirmé par écrit le
 * chat sur le binaire hébergé). Liste de hub_user_id dans ATELIER_COMPTES, séparés par des virgules.
 */
export function abonnementOuvert(hubUserId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ATELIER_COMPTES ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(hubUserId);
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

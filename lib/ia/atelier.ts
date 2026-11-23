/**
 * Le Hub et l'atelier (moteur `claude-code-abonnement`, docs/MON-IA.md). Les deux sens sont signés avec
 * ATELIER_SECRET (HMAC sur `${ts}.${corps}`, en-tête X-Veridian-Atelier-Signature). L'atelier n'a aucun
 * autre secret ; le Hub reste le seul à joindre les apps.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MOTEUR_ABONNEMENT = 'claude-code-abonnement';
export const FOURNISSEUR_ABONNEMENT = 'claude-abonnement';

/** Le suffixe d'atelier d'un tenant : 8 premiers caractères hexadécimaux de son identifiant (service hub-atelier-<t8>). */
export const suffixeAtelier = (tenantId: string): string => tenantId.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);

/**
 * L'atelier du tenant (décision A : un atelier par tenant ouvert, jamais d'atelier commun depuis la bascule D2 du 23/11),
 * lu dans ATELIER_PAR_TENANT_FICHIER que Nomad tient à jour (« hub-atelier-<t8> http://adresse:port » par ligne,
 * relu à chaque appel). Un tenant sans atelier propre n'en a aucun : jamais celui d'un autre.
 */
export function adresseAtelierDuTenant(tenantId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.ATELIER_PAR_TENANT_FICHIER) return undefined;
  const service = `hub-atelier-${suffixeAtelier(tenantId)}`;
  try {
    const ligne = readFileSync(env.ATELIER_PAR_TENANT_FICHIER, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((l) => l[0] === service);
    return ligne?.[1] || undefined;
  } catch {
    return undefined; // fichier pas encore rendu
  }
}

function config(env: NodeJS.ProcessEnv = process.env, tenantId?: string) {
  const url = tenantId ? adresseAtelierDuTenant(tenantId, env)?.replace(/\/+$/, '') : undefined;
  const secret = env.ATELIER_SECRET ?? '';
  return url && secret.length >= 32 ? { url, secret } : null;
}

/** Le tenant a-t-il un atelier joignable (service rendu, secret posé) ? */
export const atelierConfigure = (tenantId: string | null | undefined, env?: NodeJS.ProcessEnv) => config(env, tenantId ?? undefined) !== null;

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

/** Le premier espace du compte où l'abonnement est ouvert (son atelier sert la connexion), ou null. */
export async function tenantOuvertDuCompte(db: DbTenants, hubUserId: string): Promise<string | null> {
  const lignes = await db.tenant.findMany({ where: { userId: hubUserId, deletedAt: null }, select: { id: true, metadata: true } } as never);
  return lignes.find((l) => ouvertDans(l.metadata))?.id ?? null;
}

export function capaciteAtelier(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ATELIER_CAPACITE ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

export async function appelerAtelier(
  chemin: string,
  corps: object,
  opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; tenantId?: string } = {},
): Promise<Response> {
  const c = config(opts.env, opts.tenantId);
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
  // Le secret seul : la vérification ne dépend d'aucune adresse d'atelier (D2 : plus d'atelier commun, 23/11).
  const secret = env.ATELIER_SECRET ?? '';
  const ts = headers.get('x-veridian-timestamp') ?? '';
  const sig = (headers.get('x-veridian-atelier-signature') ?? '').toLowerCase();
  if (secret.length < 32 || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(maintenant - tsMs) > 5 * 60_000) return false;
  const attendu = Buffer.from(createHmac('sha256', secret).update(`${ts}.${brut}`).digest('hex'));
  const recu = Buffer.from(sig);
  return attendu.length === recu.length && timingSafeEqual(attendu, recu);
}

/**
 * Quel espace CRM affiche la fenêtre ? (docs/MON-IA.md, « Le CRM », menace 8.)
 *
 * Le plugin sert la fenêtre par le widget IFRAME natif de Twenty, à une adresse figée : le Hub retrouve l'espace par
 * l'origine de la page hôte (en-tête Referer). Il ne connaît pas le sous-domaine d'un workspace : il le demande au
 * plugin de cette origine,
 *   GET <origine>/s/veridian-ia/espace   X-Veridian-Ia-Jeton: <JWT ES256 du Hub, scope ia.espace, aud = l'URL exacte>
 *   → 200 { workspace_id }  (le workspace que Twenty sert sur cet hôte)
 * (Twenty retire `Authorization` des requêtes de ses fonctions de plugin : le jeton voyage dans son propre en-tête.)
 *
 * SSRF : le Referer est fourni par l'appelant. Aucun appel sortant tant que l'origine n'est pas exactement
 * `https://<label>.<hôte de CRM_API_URL>` (port par défaut, ni IP, ni autre domaine : `origineCrmValide`) ; délai de
 * 3 s, aucune redirection suivie. Fermé par défaut : sans réponse lisible, refus. Seules les réponses lisibles sont
 * gardées, 5 minutes.
 */
import { origineCrmValide } from './fils';
import { signerPourRouteApp } from '@/lib/mcp/identite';

export const CHEMIN_ESPACE_PLUGIN = '/s/veridian-ia/espace';
export const EN_TETE_JETON = 'X-Veridian-Ia-Jeton';
const DUREE_MEMOIRE_MS = 5 * 60_000;
const DELAI_MS = 3_000;
const memoire = new Map<string, { workspaceId: string; jusqua: number }>();

export type VerdictEspace = 'ok' | 'origine_invalide' | 'origine_etrangere' | 'non_abouti';
type Opts = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; maintenant?: number };

export function oublierEspacesCrm() {
  memoire.clear();
}

/** L'origine d'un en-tête Referer, ou null. */
export function origineDe(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/** Le workspace que Twenty sert sur cette origine, ou un refus. */
export async function workspaceDeLOrigine(
  origine: unknown,
  hubUserId: string,
  opts: Opts = {},
): Promise<{ ok: true; workspaceId: string } | { ok: false; verdict: 'origine_invalide' | 'non_abouti' }> {
  const env = opts.env ?? process.env;
  if (!origineCrmValide(origine, env)) return { ok: false, verdict: 'origine_invalide' };
  const maintenant = opts.maintenant ?? Date.now();
  const connu = memoire.get(origine);
  if (connu && connu.jusqua > maintenant) return { ok: true, workspaceId: connu.workspaceId };

  const url = `${origine}${CHEMIN_ESPACE_PLUGIN}`;
  const jeton = await signerPourRouteApp({ audience: url, hubUserId, claims: { scope: 'ia.espace' } }, env);
  if (!jeton) return { ok: false, verdict: 'non_abouti' };
  const r = await (opts.fetchImpl ?? fetch)(url, {
    headers: { [EN_TETE_JETON]: jeton },
    redirect: 'manual',
    signal: AbortSignal.timeout(DELAI_MS),
  }).catch(() => null);
  if (!r || r.status !== 200) return { ok: false, verdict: 'non_abouti' };
  const j = (await r.json().catch(() => null)) as { workspace_id?: unknown } | null;
  if (typeof j?.workspace_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(j.workspace_id)) return { ok: false, verdict: 'non_abouti' };
  memoire.set(origine, { workspaceId: j.workspace_id, jusqua: maintenant + DUREE_MEMOIRE_MS });
  return { ok: true, workspaceId: j.workspace_id };
}

/** L'origine sert-elle bien ce workspace ? */
export async function verifierEspaceCrm(origine: unknown, workspaceId: string, hubUserId: string, opts: Opts = {}): Promise<VerdictEspace> {
  const w = await workspaceDeLOrigine(origine, hubUserId, opts);
  if (!w.ok) return w.verdict;
  return w.workspaceId === workspaceId ? 'ok' : 'origine_etrangere';
}

/** Le refus d'API qui correspond au verdict (jamais muet : le code dit pourquoi). */
export function refusEspaceHote(verdict: Exclude<VerdictEspace, 'ok'>) {
  return verdict === 'non_abouti'
    ? Response.json({ error: 'espace_hote_non_verifie' }, { status: 503 })
    : Response.json({ error: 'espace_hote_refuse', raison: verdict }, { status: 403 });
}

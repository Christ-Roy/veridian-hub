/**
 * L'espace CRM qui affiche la fenêtre est-il bien celui du workspace demandé ? (docs/MON-IA.md, « Le CRM », menace 8.)
 *
 * frame-ancestors laisse tout `*.crm.app.veridian.site` afficher la fenêtre : un autre espace Twenty pourrait l'afficher
 * avec le workspace de sa victime, ou poster au Hub une origine à lui pour recevoir le fil (donc les données lues). Le
 * Hub ne connaît pas le sous-domaine d'un workspace : il le demande au plugin de l'origine elle-même,
 *   GET <origine>/s/veridian-ia/espace   Authorization: Bearer <JWT ES256 du Hub, scope ia.espace, aud = l'URL exacte>
 *   → 200 { workspace_id }  (le workspace que Twenty sert sur cet hôte)
 * et compare. Fermé par défaut : sans réponse lisible, refus. Seules les réponses concordantes sont gardées en mémoire.
 */
import { origineCrmValide } from './fils';
import { signerPourRouteApp } from '@/lib/mcp/identite';

export const CHEMIN_ESPACE_PLUGIN = '/s/veridian-ia/espace';
const DUREE_MEMOIRE_MS = 10 * 60_000;
const memoire = new Map<string, { workspaceId: string; jusqua: number }>();

export type VerdictEspace = 'ok' | 'origine_invalide' | 'origine_etrangere' | 'non_abouti';

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

export async function verifierEspaceCrm(
  origine: unknown,
  workspaceId: string,
  hubUserId: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; maintenant?: number } = {},
): Promise<VerdictEspace> {
  const env = opts.env ?? process.env;
  if (!origineCrmValide(origine, env)) return 'origine_invalide';
  const maintenant = opts.maintenant ?? Date.now();
  const connu = memoire.get(origine);
  if (connu && connu.jusqua > maintenant) return connu.workspaceId === workspaceId ? 'ok' : 'origine_etrangere';

  const url = `${origine}${CHEMIN_ESPACE_PLUGIN}`;
  const jeton = await signerPourRouteApp({ audience: url, hubUserId, claims: { scope: 'ia.espace', workspace_id: workspaceId } }, env);
  if (!jeton) return 'non_abouti';
  const r = await (opts.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!r?.ok) return 'non_abouti';
  const j = (await r.json().catch(() => null)) as { workspace_id?: unknown } | null;
  if (typeof j?.workspace_id !== 'string') return 'non_abouti';
  if (j.workspace_id !== workspaceId) return 'origine_etrangere';
  memoire.set(origine, { workspaceId, jusqua: maintenant + DUREE_MEMOIRE_MS });
  return 'ok';
}

/** Le refus d'API qui correspond au verdict (jamais muet : le code dit pourquoi). */
export function refusEspaceHote(verdict: Exclude<VerdictEspace, 'ok'>) {
  return verdict === 'non_abouti'
    ? Response.json({ error: 'espace_hote_non_verifie' }, { status: 503 })
    : Response.json({ error: 'espace_hote_refuse', raison: verdict }, { status: 403 });
}

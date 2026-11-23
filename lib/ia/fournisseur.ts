/**
 * Le fournisseur d'IA « Veridian » du chat natif de Twenty (docs/MON-IA.md, « Le fournisseur Veridian du chat natif
 * de Twenty ») : un point d'accès compatible OpenAI, routé vers le moteur de l'utilisateur.
 *
 * - Deux niveaux d'authentification : la clé de l'instance (Bearer IA_FOURNISSEUR_CLE) et l'identité du membre
 *   (X-Veridian-Ia-Identite, JWT HS256 signé par Twenty avec IA_IDENTITE_SECRET, 60 s, jti jamais rejoué).
 * - `cle-api` : relais transparent vers le point compatible OpenAI du fournisseur de l'utilisateur ; les outils de
 *   Twenty passent tels quels, le Hub n'en exécute aucun.
 * - `claude-code-abonnement` : la boucle de l'atelier (outils de la porte MCP, identité du membre), lecture seule ;
 *   le Hub ne rend que le texte en SSE.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { jwtVerify } from 'jose';

import type { Fournisseur } from './branchements';
import { masquer } from './coffre';

export const MODELE_VERIDIAN = 'veridian-auto';
export const AUDIENCE_FOURNISSEUR = 'https://app.veridian.site/api/ia/v1';
export const EMETTEUR_CRM = 'veridian-crm';
const FIL = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUREE_MAX_S = 60;

export type Identite = { workspaceId: string; hubUserId: string; fil: string };
export type RefusAppel = { refus: string };

// ── Authentification ──

/** Comparaison à temps constant, sur les empreintes (longueurs différentes comprises). */
function egal(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const vus = new Map<string, number>();
export function oublierJetonsVus() {
  vus.clear();
}

export async function verifierAppel(
  entetes: Headers,
  env: NodeJS.ProcessEnv = process.env,
  maintenant: number = Date.now(),
): Promise<Identite | RefusAppel> {
  const cle = env.IA_FOURNISSEUR_CLE ?? '';
  const secret = env.IA_IDENTITE_SECRET ?? '';
  if (cle.length < 32 || secret.length < 32) return { refus: 'fournisseur_non_configure' };

  const auth = entetes.get('authorization') ?? '';
  const porteur = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!porteur || !egal(porteur, cle)) return { refus: 'cle_instance' };

  const jeton = entetes.get('x-veridian-ia-identite') ?? '';
  if (!jeton) return { refus: 'identite_absente' };
  let p: Record<string, unknown>;
  try {
    ({ payload: p } = await jwtVerify(jeton, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: EMETTEUR_CRM,
      audience: AUDIENCE_FOURNISSEUR,
      currentDate: new Date(maintenant),
      // Âge du jeton borné par jose (il exige le champ d'émission) ; l'échéance ne peut pas dépasser 60 s.
      maxTokenAge: DUREE_MAX_S,
      requiredClaims: ['exp', 'jti'],
    }));
  } catch {
    return { refus: 'identite_invalide' };
  }
  if (!(Number(p.exp) * 1000 <= maintenant + DUREE_MAX_S * 1000)) return { refus: 'identite_duree' };
  const { workspace_id: ws, hub_user_id: qui, fil: filBrut, jti } = p as Record<string, unknown>;
  // Un agent de Twenty sans humain derrière n'a pas de membre : il n'a pas d'IA à lui (refus nommé).
  if (qui === null || qui === undefined) return { refus: 'agent_sans_membre' };
  // Génération simple, hors fil de discussion : la session se dérive d'un fil « sans-fil ».
  const fil = filBrut === null || filBrut === undefined ? 'sans-fil' : filBrut;
  if (typeof ws !== 'string' || !UUID.test(ws) || typeof qui !== 'string' || !UUID.test(qui) || typeof fil !== 'string' || !FIL.test(fil)) {
    return { refus: 'identite_incomplete' };
  }
  vus.forEach((fin, k) => {
    if (fin < maintenant) vus.delete(k);
  });
  if (vus.has(String(jti))) return { refus: 'identite_rejouee' };
  vus.set(String(jti), maintenant + 120_000);
  return { workspaceId: ws, hubUserId: qui, fil };
}

/** Session du moteur pour ce fil : dérivée du triplet et du fil (menace 7), jamais choisie par Twenty seul. */
export function sessionDuFil(t: { hubUserId: string; app: string; tenantId: string }, fil: string): string {
  const h = createHash('sha1').update(`veridian-hub/ia/fil/v1:${t.hubUserId}:${t.app}:${t.tenantId}:${fil}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // uuid v5
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ── Réponses au format OpenAI ──

export function erreurOpenAI(statut: number, code: string, message: string): Response {
  return Response.json({ error: { message, type: statut === 429 ? 'rate_limit_error' : 'invalid_request_error', code } }, { status: statut });
}

export function morceau(id: string, delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>): string {
  const corps: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODELE_VERIDIAN,
    choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) corps.usage = usage;
  return `data: ${JSON.stringify(corps)}\n\n`;
}

// ── Moteur clé API : relais transparent ──

export const BASES_COMPATIBLES: Record<Fournisseur, string> = {
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  // Anthropic : sa compatibilité OpenAI (/v1/chat/completions), outils et flux compris.
  anthropic: 'https://api.anthropic.com/v1',
};

/** Le corps envoyé au fournisseur : celui de Twenty, avec le modèle et la clé de l'utilisateur. */
export function corpsRelaye(corps: Record<string, unknown>, fournisseur: Fournisseur, modele: string): Record<string, unknown> {
  const sortie: Record<string, unknown> = { ...corps, model: modele };
  if (sortie.stream === true && fournisseur !== 'mistral') {
    sortie.stream_options = { ...((sortie.stream_options as object) ?? {}), include_usage: true };
  }
  return sortie;
}

/**
 * Relaie le flux du fournisseur tel quel, en relevant au passage les jetons et le nombre d'appels d'outils (pour
 * l'audit), sans rien garder du contenu.
 */
export function relaisAvecMesure(
  corps: ReadableStream<Uint8Array>,
  fin: (m: { jetons: number | null; outils: number }) => void,
): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  let reste = '';
  let jetons: number | null = null;
  let outils = 0;
  return corps.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bloc, ctrl) {
        ctrl.enqueue(bloc);
        reste += dec.decode(bloc, { stream: true });
        let i;
        while ((i = reste.indexOf('\n')) >= 0) {
          const ligne = reste.slice(0, i).trim();
          reste = reste.slice(i + 1);
          if (!ligne.startsWith('data:') || ligne === 'data: [DONE]') continue;
          try {
            const j = JSON.parse(ligne.slice(5)) as { usage?: { total_tokens?: number }; choices?: { delta?: { tool_calls?: unknown[] } }[] };
            if (typeof j.usage?.total_tokens === 'number') jetons = j.usage.total_tokens;
            for (const c of j.choices ?? []) outils += (c.delta?.tool_calls ?? []).filter((t) => (t as { id?: unknown }).id).length;
          } catch {
            /* morceau illisible : relayé tel quel, pas mesuré */
          }
        }
      },
      flush() {
        fin({ jetons, outils });
      },
    }),
  );
}

export async function appelerFournisseur(
  b: { fournisseur: Fournisseur; modele: string; cle: string },
  corps: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | RefusAppel> {
  const r = await fetchImpl(`${BASES_COMPATIBLES[b.fournisseur]}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.cle}` },
    body: JSON.stringify(corpsRelaye(corps, b.fournisseur, b.modele)),
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  }).catch((e: unknown) => {
    console.error('[ia][fournisseur] relais injoignable', masquer(e instanceof Error ? e.message : String(e), [b.cle]));
    return null;
  });
  if (!r) return { refus: 'fournisseur_injoignable' };
  if (!r.ok) {
    // Le statut seulement : le corps d'une erreur peut citer la clé.
    console.error('[ia][fournisseur] refus du fournisseur', JSON.stringify({ fournisseur: b.fournisseur, statut: r.status }));
    return { refus: r.status === 429 ? 'fournisseur_plafond' : r.status === 401 || r.status === 403 ? 'cle_refusee' : 'fournisseur_erreur' };
  }
  return r;
}

// ── Moteur abonnement : la dernière question ──

export function derniereQuestionOpenAI(messages: unknown): string {
  const liste = Array.isArray(messages) ? (messages as { role?: string; content?: unknown }[]) : [];
  const m = [...liste].reverse().find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content.trim();
  if (Array.isArray(m.content)) {
    return (m.content as { type?: string; text?: string }[]).map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('\n').trim();
  }
  return '';
}

/**
 * Vérifier qu'une clé d'IA est reconnue par son fournisseur, sans rien dépenser : on demande la liste des
 * modèles (ou, chez OpenRouter, l'état de la clé), jamais une réponse du modèle. Trois états (doctrine §5) :
 * `reconnue`, `refusee` (401 ou 403 du fournisseur), `non_abouti` (réseau, 5xx, réponse inattendue).
 * « Reconnue » ne prouve pas qu'il reste du crédit : seul OpenRouter le dit (`credit_restant`).
 *
 * Rien du corps de la réponse ne remonte, sauf des nombres : une erreur du fournisseur peut citer la clé.
 */
import type { Fournisseur } from './branchements';

export type Verification = { etat: 'reconnue' | 'refusee' | 'non_abouti'; statut: number | null; credit_restant?: number | null };

const SONDES: Record<Fournisseur, (cle: string) => { url: string; headers: Record<string, string> }> = {
  anthropic: (cle) => ({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': cle, 'anthropic-version': '2023-06-01' } }),
  openai: (cle) => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${cle}` } }),
  mistral: (cle) => ({ url: 'https://api.mistral.ai/v1/models', headers: { Authorization: `Bearer ${cle}` } }),
  openrouter: (cle) => ({ url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${cle}` } }),
};

export async function verifierCle(fournisseur: Fournisseur, cle: string, fetchImpl: typeof fetch = fetch): Promise<Verification> {
  const { url, headers } = SONDES[fournisseur](cle.trim());
  const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!r) return { etat: 'non_abouti', statut: null };
  if (r.status === 401 || r.status === 403) return { etat: 'refusee', statut: r.status };
  if (!r.ok) return { etat: 'non_abouti', statut: r.status };
  if (fournisseur !== 'openrouter') return { etat: 'reconnue', statut: r.status };
  const j = (await r.json().catch(() => null)) as { data?: { limit_remaining?: unknown } } | null;
  const reste = j?.data?.limit_remaining;
  return { etat: 'reconnue', statut: r.status, credit_restant: typeof reste === 'number' ? reste : null };
}

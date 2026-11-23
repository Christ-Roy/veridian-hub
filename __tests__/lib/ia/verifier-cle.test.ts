/** La vérification d'une clé ne coûte rien (liste des modèles) et dit trois états, jamais deux. */
import { describe, expect, it, vi } from 'vitest';

import { verifierCle } from '@/lib/ia/verifier-cle';

const rep = (status: number, corps: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(corps), { status })) as unknown as typeof fetch;

describe('verifierCle', () => {
  it('Anthropic : sonde la liste des modèles, jamais /messages', async () => {
    const f = rep(200);
    expect(await verifierCle('anthropic', 'sk-ant-xxxxxxxxxxxxxxxx', f)).toEqual({ etat: 'reconnue', statut: 200 });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/models');
    expect(url).not.toContain('/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-xxxxxxxxxxxxxxxx');
  });

  it('401 : refusée', async () => {
    expect((await verifierCle('openai', 'sk-xxxxxxxxxxxxxxxx', rep(401))).etat).toBe('refusee');
  });

  it('réseau en panne ou 5xx : non abouti, jamais « reconnue »', async () => {
    const panne = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect((await verifierCle('mistral', 'k'.repeat(20), panne)).etat).toBe('non_abouti');
    expect((await verifierCle('mistral', 'k'.repeat(20), rep(503))).etat).toBe('non_abouti');
  });

  it('OpenRouter : rend le crédit restant, rien d\'autre du corps', async () => {
    const v = await verifierCle('openrouter', 'sk-or-xxxxxxxxxxxxxxxx', rep(200, { data: { limit_remaining: 0, label: 'sk-or-v1-abc...' } }));
    expect(v).toEqual({ etat: 'reconnue', statut: 200, credit_restant: 0 });
  });
});

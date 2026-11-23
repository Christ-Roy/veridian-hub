/**
 * Fils « Mon IA » rangés dans l'app (lib/ia/fils.ts), contrat HMAC. Le CRM n'en est plus : son chat natif range
 * ses fils lui-même.
 */
import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ecrireFil, lireFil } from '@/lib/ia/fils';

let env: NodeJS.ProcessEnv;
const cible = { sessionId: 's-1', hubUserId: '53245ae1-6bf8-4ec6-870f-32d75b7c0281', tenantId: 't-1' };

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  env = {
    MCP_SIGNING_JWK: JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'test-fils' }),
    CRM_API_URL: 'https://crm.app.veridian.site',
    ACADEMY_API_URL: 'https://academy.app.veridian.site',
    ACADEMY_HUB_API_SECRET: 's'.repeat(40),
    NEXT_PUBLIC_SITE_URL: 'https://app.veridian.site',
  } as NodeJS.ProcessEnv;
});

describe('fils du CRM : le Hub ne les range plus (chat natif, 23/11)', () => {
  it('aucun appel, ni au plugin ni ailleurs', async () => {
    const fetchImpl = vi.fn();
    const f = fetchImpl as unknown as typeof fetch;
    expect(await ecrireFil('crm', { ...cible, messages: [] }, { env, fetchImpl: f })).toBe(false);
    expect(await lireFil('crm', cible, { env, fetchImpl: f })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fils des autres apps : contrat HMAC inchangé', () => {
  it('Academy : PUT <ACADEMY_API_URL>/api/hub/ia/fils/:session signé', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await ecrireFil('academy', { ...cible, messages: [] }, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://academy.app.veridian.site/api/hub/ia/fils/s-1');
    expect((init.headers as Record<string, string>)['X-Veridian-Hub-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ hub_user_id: cible.hubUserId, tenant_id: 't-1' });
  });
});

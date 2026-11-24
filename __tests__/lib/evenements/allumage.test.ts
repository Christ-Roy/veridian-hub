// @vitest-environment node
import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const poser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/evenements/abonnement', () => ({ poserAbonnement: poser }));

import { suivreAbonnement } from '@/lib/evenements/allumage';

const ENV = { NODE_ENV: 'test', NOTIFUSE_API_URL: 'https://n.test', NOTIFUSE_HUB_API_SECRET: 's' } as NodeJS.ProcessEnv;
const SECRET = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
let appels: { u: string; corps: unknown }[];
const n = (r: () => Response) => (async (u: string, i: RequestInit) => {
  const h = i.headers as Record<string, string>;
  expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 's').update(`${h['X-Veridian-Timestamp']}.${i.body}`).digest('hex'));
  appels.push({ u, corps: JSON.parse(String(i.body)) });
  return r();
}) as unknown as typeof fetch;
const suivre = (actif: boolean, r: () => Response, paire = 'notifuse>crm') => suivreAbonnement({} as never, { tenantId: 'T', paire, actif }, ENV, n(r));
beforeEach(() => { appels = []; poser.mockReset(); });

describe('suivreAbonnement', () => {
  it('allumer : demande l\'abonnement signé et range le secret de CETTE organisation', async () => {
    expect(await suivre(true, () => Response.json({ workspace_id: 'ws', subscription_id: 'x', secret: SECRET }))).toBe('fait');
    expect(appels[0]).toEqual({ u: 'https://n.test/api/hub/evenements/abonnement', corps: { hub_tenant_id: 'T', actif: true } });
    expect(poser.mock.calls[0][1]).toEqual({ tenantId: 'T', source: 'notifuse', cleExterne: 'ws', secret: SECRET });
  });
  it('couper : retire chez la source, ne range rien', async () => {
    expect(await suivre(false, () => Response.json({ workspace_id: 'ws' }))).toBe('fait');
    expect(poser).not.toHaveBeenCalled();
  });
  it('refus, panne, secret absent ou mal formé : échec dit, rien n\'est rangé', async () => {
    for (const r of [() => new Response('', { status: 404 }), () => Response.json({ workspace_id: 'ws' }), () => Response.json({ workspace_id: 'ws', secret: 'court' }), () => { throw new Error('réseau'); }]) expect(await suivre(true, r)).toBe('echec');
    expect(poser).not.toHaveBeenCalled();
  });
  it('une autre paire : rien n\'est appelé', async () => {
    expect(await suivre(true, () => Response.json({}), 'prospection>crm')).toBe('sans_objet');
    expect(appels).toEqual([]);
  });
});

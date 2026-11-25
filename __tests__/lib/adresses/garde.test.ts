// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ push: vi.fn(), decouvrir: vi.fn() }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => m.push(...a) }));
vi.mock('@/lib/sync/discovery', () => ({ configuredSyncApps: () => ['notifuse', 'prospection'], discoverAppForEmail: (...a: unknown[]) => m.decouvrir(...a) }));

import { APPS_PAR_ADRESSE, direArret, verifierApps } from '@/lib/adresses/garde';

beforeEach(() => {
  m.push.mockReset().mockResolvedValue({ notifuse: 'not_in_app', prospection: 'ok' });
  m.decouvrir.mockReset().mockResolvedValue({ found: false });
});
describe('verifierApps', () => {
  it('interroge sans rien écrire ; rend les apps qui suivront par hub_user_id', async () => {
    expect(await verifierApps({ hubUserId: 'h', email: 'a@x.fr' })).toEqual({ reliees: ['prospection'] });
    expect(m.push.mock.calls).toEqual([[{ hubUserId: 'h' }, { apps: ['notifuse', 'prospection'], fetchImpl: undefined }]]);
  });
  it('une app par adresse l\'emporte sur une app muette : c\'est elle qu\'on nomme', async () => {
    m.push.mockResolvedValue({ notifuse: 'ok', prospection: 'failed' });
    expect(await verifierApps({ hubUserId: 'h', email: 'a@x.fr' })).toEqual({ refus: 'app_par_adresse', apps: ['notifuse'] });
  });
  it('sans identité Hub, aucune app n\'est interrogée par elle', async () => {
    m.decouvrir.mockImplementation(async (a: string) => ({ found: a === 'prospection' }));
    expect(await verifierApps({ hubUserId: null, email: 'a@x.fr' })).toEqual({ refus: 'app_non_reliee', apps: ['prospection'] });
    expect(m.push).not.toHaveBeenCalled();
  });
});
describe('direArret', () => {
  it('nomme les apps, accorde, et rassure', () => {
    expect(direArret({ refus: 'app_par_adresse', apps: ['notifuse', 'crm', 'academy'] })).toBe('Mail, le CRM et Academy vous reconnaissent encore par votre adresse et ne suivraient pas ce changement. Rien n\'a changé : votre adresse actuelle continue de marcher partout.');
    expect(direArret({ refus: 'app_non_reliee', apps: ['crm'] })).toMatch(/^Le CRM ne vous connaît que/);
    expect(direArret({ refus: 'app_indisponible', apps: ['analytics'] })).toMatch(/^Analytics ne répond pas/);
  });
});
describe('APPS_PAR_ADRESSE', () => {
  it('Mail, CRM, Academy : en sortir se décide, avec l\'épreuve (CONTRAT-HUB §5.19.7)', () => expect([...APPS_PAR_ADRESSE].sort()).toEqual(['academy', 'crm', 'notifuse']));
});

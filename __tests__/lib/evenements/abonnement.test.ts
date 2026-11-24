import { beforeEach, describe, expect, it } from 'vitest';

import { lireAbonnement, poserAbonnement } from '@/lib/evenements/abonnement';

import { base } from './fausse';

const env = { NODE_ENV: 'test', VAULT_ENC_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
beforeEach(() => { db = base(); });

describe('abonnement', () => {
  it('le secret est chiffré en base, jamais clair, et se relit', async () => {
    await poserAbonnement(db as never, { tenantId: 'T', source: 'notifuse', cleExterne: 'ws1', secret: 'whsec_TRES-SECRET' }, env);
    expect(JSON.stringify(db.evenementAbonnement.lignes)).not.toContain('TRES-SECRET');
    expect(await lireAbonnement(db as never, 'notifuse', 'ws1', env)).toEqual({ tenantId: 'T', secret: 'whsec_TRES-SECRET' });
  });
  it('reposer remplace le secret ; un abonnement inconnu rend null ; un autre coffre ne le lit pas', async () => {
    await poserAbonnement(db as never, { tenantId: 'T', source: 'notifuse', cleExterne: 'ws1', secret: 'un' }, env);
    await poserAbonnement(db as never, { tenantId: 'T', source: 'notifuse', cleExterne: 'ws1', secret: 'deux' }, env);
    expect(db.evenementAbonnement.lignes).toHaveLength(1);
    expect((await lireAbonnement(db as never, 'notifuse', 'ws1', env))?.secret).toBe('deux');
    expect(await lireAbonnement(db as never, 'notifuse', 'autre', env)).toBeNull();
    await expect(lireAbonnement(db as never, 'notifuse', 'ws1', { ...env, VAULT_ENC_KEY: 'z'.repeat(40) })).rejects.toThrow();
  });
});

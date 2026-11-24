import { describe, expect, it, vi } from 'vitest';

import { isTestAccount, measureTestResidue, residueCounts } from '@/lib/sync/test-residue';

const avec = (emails: string[]) =>
  ({ user: { findMany: vi.fn(async () => emails.map((email) => ({ email }))) } }) as never;
const audit = (withoutHub: string[], unlinked: string[] = []) =>
  ({ notifuse: { status: 'ok', localAccounts: 0, withoutHub, unlinked, emailMismatch: [], nameMismatch: [] } }) as never;

describe('restes de test', () => {
  it('reconnaît les comptes de test, jamais un vrai client', () => {
    for (const e of ['e2e-sso-x-a@veridian.site', 'parcours+1@veridian.site', 'brunon5robert+t@gmail.com', 'z@yopmail.com']) {
      expect(isTestAccount(e), e).toBe(true);
    }
    for (const e of ['contact@fgmc.pro', 'brunon5robert@gmail.com', 'e2e@client.fr', 'parcours@client.fr']) {
      expect(isTestAccount(e), e).toBe(false);
    }
  });

  it('compte le Hub, les apps et les tenants orphelins', async () => {
    const r = await measureTestResidue(
      avec(['e2e-sso-a@veridian.site', 'vrai@client.fr']),
      audit(['e2e-sso-b@veridian.site', 'vrai2@client.fr'], ['brunon5robert+x@gmail.com']),
      14,
    );
    expect(r.hub).toEqual(['e2e-sso-a@veridian.site']);
    expect(r.apps.notifuse).toEqual(['e2e-sso-b@veridian.site', 'brunon5robert+x@gmail.com']);
    expect(r.total).toBe(17);
  });

  it('compte les workspaces Notifuse, et une lecture impossible reste visible', async () => {
    const lus = await measureTestResidue(avec([]), audit([]), 0, async (p) => (p === 'e2e' ? ['e2essox'] : []));
    expect(lus.notifuseWorkspaces).toEqual(['e2essox']);
    expect(lus.total).toBe(1);
    const panne = await measureTestResidue(avec([]), audit([]), 0, async () => {
      throw new Error('down');
    });
    expect(panne.notifuseWorkspaces).toBeNull();
  });

  it('un compte de test permanent, reconnu par son hub_user_id, n\'est pas un reste ; la même adresse sous un autre identifiant en est un', async () => {
    const base = (supabaseUserId: string | null) => ({ user: { findMany: vi.fn(async () => [{ email: 'brunon5robert+p@gmail.com', supabaseUserId }]) } }) as never;
    const permanent = await measureTestResidue(base('9608d959-6ebb-4ec6-ad10-6d9bbe66e4b0'), audit([], ['brunon5robert+p@gmail.com', 'e2e-a@veridian.site']), 0);
    expect(permanent.hub).toEqual([]);
    expect(permanent.apps.notifuse, 'les autres restes comptent toujours').toEqual(['e2e-a@veridian.site']);
    for (const id of ['autre', null]) expect((await measureTestResidue(base(id), audit([]), 0)).total).toBe(1);
  });

  it('zéro quand tout est propre, et les logs ne portent aucune adresse', async () => {
    const r = await measureTestResidue(avec([]), audit(['vrai@client.fr']), 0);
    expect(r.total).toBe(0);
    expect(JSON.stringify(residueCounts(r))).not.toContain('@');
  });
});

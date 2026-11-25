// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ADMINS_CONNUS, adminsPlateforme, estAdresseOperateur, isPlatformAdminId, lireAdmins } from '@/lib/admin/liste-admins';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const AUTRE = '11111111-2222-4333-8444-555555555555';
afterEach(() => vi.unstubAllEnvs());

describe('lireAdmins', () => {
  it('casse, espaces et virgule finale', () => expect([...lireAdmins(` ${ROBERT.toUpperCase()} , ${AUTRE},`)!]).toEqual([ROBERT, AUTRE]));
  it.each([undefined, '', ' , ', 'robert@x.fr', `${ROBERT},robert@x.fr`, `${ROBERT};${AUTRE}`])('%j est illisible en entier', (l) => expect(lireAdmins(l)).toBeNull());
});
describe('adminsPlateforme', () => {
  it('lisible : exactement la liste', () => { vi.stubEnv('PLATFORM_ADMINS', AUTRE); expect([[...adminsPlateforme()], isPlatformAdminId(ROBERT), isPlatformAdminId(AUTRE)]).toEqual([[AUTRE], false, true]); });
  it('illisible : la liste connue, et c\'est dit une fois', () => {
    const cri = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('PLATFORM_ADMINS', `${AUTRE},x`);
    expect([adminsPlateforme(), adminsPlateforme()]).toEqual([ADMINS_CONNUS, ADMINS_CONNUS]);
    expect(cri.mock.calls.length).toBeLessThanOrEqual(1);
    cri.mockRestore();
  });
  it('rien ne vaut personne', () => expect([isPlatformAdminId(null), isPlatformAdminId(undefined), isPlatformAdminId('')]).toEqual([false, false, false]));
});
it('estAdresseOperateur ne donne aucun droit', () => { vi.stubEnv('ADRESSES_OPERATEUR', 'Robert@X.fr'); expect([estAdresseOperateur(' robert@x.FR '), isPlatformAdminId('robert@x.fr')]).toEqual([true, false]); });

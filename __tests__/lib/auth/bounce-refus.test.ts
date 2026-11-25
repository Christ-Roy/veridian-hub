// @vitest-environment node
/** Journal des rebonds : refus et réussite se recoupent par app et compte, sans jamais l'adresse ni le lien. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { journaliserRefus, journaliserReussite, REFUS_IDENTITE } from '@/lib/auth/bounce-refus';

afterEach(() => vi.restoreAllMocks());
const capter = (m: 'info' | 'warn' | 'error') => {
  const l: string[] = [];
  vi.spyOn(console, m).mockImplementation((x) => void l.push(String(x)));
  return l;
};

describe('journaliserReussite', () => {
  it('une ligne JSON : app, code, compte, instant, et rien d\'autre', () => {
    const l = capter('info');
    journaliserReussite({ app: 'prospection', code: 'ok', hubUserId: 'u-1' });
    expect(l).toHaveLength(1);
    const j = JSON.parse(l[0]);
    expect(Object.keys(j).sort()).toEqual(['app', 'code', 'hub_user_id', 'level', 'msg', 'tag', 'ts']);
    expect(j).toMatchObject({ tag: '[bounce][reussi]', app: 'prospection', code: 'ok', hub_user_id: 'u-1' });
  });
});

describe('journaliserRefus', () => {
  it('refus d\'identité en warn, le reste en error ; mêmes champs', () => {
    const [w, e] = [capter('warn'), capter('error')];
    journaliserRefus({ app: 'crm', code: 'user_not_in_app', hubUserId: 'u', httpStatus: 400 });
    journaliserRefus({ app: 'crm', code: 'unreachable', hubUserId: null });
    expect([w.length, e.length]).toEqual([1, 1]);
    expect(JSON.parse(w[0])).toMatchObject({ tag: '[bounce][refus]', app: 'crm', code: 'user_not_in_app', hub_user_id: 'u', http_status: 400 });
  });
});

describe('REFUS_IDENTITE', () => {
  it('un espace suspendu est un refus voulu, pas une panne : il n\'alerte personne', () => {
    const [w, e] = [capter('warn'), capter('error')];
    expect(REFUS_IDENTITE).toContain('workspace_suspended');
    journaliserRefus({ app: 'crm', code: 'workspace_suspended', hubUserId: 'u', httpStatus: 423 });
    expect([w.length, e.length]).toEqual([1, 0]);
  });
});

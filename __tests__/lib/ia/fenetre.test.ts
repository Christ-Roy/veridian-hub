/**
 * Menace 8 (docs/MON-IA.md) : frame-ancestors laisse tout *.crm.app.veridian.site afficher la fenêtre. Elle refuse,
 * visiblement, un espace qui n'est pas à l'utilisateur, et une page hôte qui n'est pas l'espace CRM de ce workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ia/contexte', () => ({ espaceDe: vi.fn() }));
vi.mock('@/lib/mcp/identite', () => ({ signerPourRouteApp: vi.fn(async () => 'jeton') }));

import { autoriserFenetre } from '@/lib/ia/fenetre';
import { oublierEspacesCrm, verifierEspaceCrm } from '@/lib/ia/espace-crm';

const WS_ROBERT = '38627be0-428f-4924-aa67-4a35884ba7b4';
const WS_AUTRE = '11111111-2222-4333-8444-555555555555';
const espaceRobert = { id: 'tenant-robert', slug: 'robert', workspaceId: WS_ROBERT };
const env = { CRM_API_URL: 'https://crm.app.veridian.site' } as NodeJS.ProcessEnv;

/** Le plugin de chaque hôte répond le workspace qu'il sert. */
function plugins(carte: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const hote = new URL(url).origin;
    return carte[hote] ? new Response(JSON.stringify({ workspace_id: carte[hote] }), { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  oublierEspacesCrm();
});

describe('autoriserFenetre', () => {
  const espaceDe = vi.fn(async (_u: string, _t: unknown, parApp?: { workspaceId: unknown }) => (parApp?.workspaceId === WS_ROBERT ? espaceRobert : null));
  const verifier = (carte: Record<string, string>) => (o: unknown, ws: string, u: string) => verifierEspaceCrm(o, ws, u, { env, fetchImpl: plugins(carte) });

  it('1. workspace d\'un autre client : refus, rien n\'est demandé au plugin', async () => {
    const v = vi.fn();
    const f = await autoriserFenetre({ app: 'crm', workspace: WS_AUTRE, referer: 'https://robert.crm.app.veridian.site/', hubUserId: 'hub-robert' }, { espaceDe, verifierEspaceCrm: v });
    expect(f).toEqual({ ok: false, refus: 'espace_etranger' });
    expect(v).not.toHaveBeenCalled();
  });

  it('2. page hôte d\'un autre espace CRM avec le workspace de Robert : refus', async () => {
    const f = await autoriserFenetre(
      { app: 'crm', workspace: WS_ROBERT, referer: 'https://pirate.crm.app.veridian.site/objects/notes', hubUserId: 'hub-robert' },
      { espaceDe, verifierEspaceCrm: verifier({ 'https://robert.crm.app.veridian.site': WS_ROBERT, 'https://pirate.crm.app.veridian.site': WS_AUTRE }) },
    );
    expect(f).toEqual({ ok: false, refus: 'origine_etrangere' });
  });

  it('2. sans Referer, ou hôte hors du CRM : refus', async () => {
    const v = verifier({ 'https://robert.crm.app.veridian.site': WS_ROBERT });
    expect(await autoriserFenetre({ app: 'crm', workspace: WS_ROBERT, referer: null, hubUserId: 'hub-robert' }, { espaceDe, verifierEspaceCrm: v })).toEqual({ ok: false, refus: 'hote_absent' });
    expect(await autoriserFenetre({ app: 'crm', workspace: WS_ROBERT, referer: 'https://robert.crm.app.veridian.site.evil.io/', hubUserId: 'hub-robert' }, { espaceDe, verifierEspaceCrm: v })).toEqual({ ok: false, refus: 'origine_invalide' });
  });

  it('2. plugin muet : refus (fermé par défaut), jamais « ok »', async () => {
    const f = await autoriserFenetre({ app: 'crm', workspace: WS_ROBERT, referer: 'https://robert.crm.app.veridian.site/', hubUserId: 'hub-robert' }, { espaceDe, verifierEspaceCrm: verifier({}) });
    expect(f).toEqual({ ok: false, refus: 'non_abouti' });
  });

  it('l\'espace CRM de Robert, affiché chez lui : ouvert, avec l\'origine vérifiée', async () => {
    const f = await autoriserFenetre(
      { app: 'crm', workspace: WS_ROBERT, referer: 'https://robert.crm.app.veridian.site/objects/companies', hubUserId: 'hub-robert' },
      { espaceDe, verifierEspaceCrm: verifier({ 'https://robert.crm.app.veridian.site': WS_ROBERT }) },
    );
    expect(f).toEqual({ ok: true, espace: espaceRobert, origine: 'https://robert.crm.app.veridian.site' });
  });

  it('Academy : l\'espace doit être à l\'utilisateur, pas de vérification d\'hôte', async () => {
    const parTenant = vi.fn(async (_u: string, t: unknown) => (t === 'tenant-robert' ? { id: 'tenant-robert', slug: 'r', workspaceId: null } : null));
    expect((await autoriserFenetre({ app: 'academy', tenant: 'tenant-autre', hubUserId: 'hub-robert' }, { espaceDe: parTenant })).ok).toBe(false);
    expect((await autoriserFenetre({ app: 'academy', tenant: 'tenant-robert', hubUserId: 'hub-robert' }, { espaceDe: parTenant })).ok).toBe(true);
  });
});

/**
 * Menace 8 (docs/MON-IA.md) : le widget IFRAME du plugin affiche la fenêtre à une adresse figée ; le Hub trouve
 * l'espace par l'origine de la page hôte. Aucune valeur par défaut : chaque cas douteux est un refus visible.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/ia/contexte', () => ({ espaceDe: vi.fn() }));
vi.mock('@/lib/mcp/identite', () => ({ signerPourRouteApp: vi.fn(async () => 'jeton') }));

import { autoriserFenetre } from '@/lib/ia/fenetre';

const WS_ROBERT = '38627be0-428f-4924-aa67-4a35884ba7b4';
const WS_AUTRE = '11111111-2222-4333-8444-555555555555';
const espaceRobert = { id: 'tenant-robert', slug: 'robert', workspaceId: WS_ROBERT };
/** Robert n'est membre que de son espace. */
const espaceDe = vi.fn(async (_u: string, _t: unknown, parApp?: { workspaceId: unknown }) => (parApp?.workspaceId === WS_ROBERT ? espaceRobert : null));
/** Ce que chaque plugin répond : le workspace servi sur son hôte. */
const servi: Record<string, string> = { 'https://robert.crm.app.veridian.site': WS_ROBERT, 'https://pirate.crm.app.veridian.site': WS_AUTRE };
const workspaceDeLOrigine = vi.fn(async (o: unknown) =>
  typeof o === 'string' && servi[o] ? { ok: true as const, workspaceId: servi[o] } : { ok: false as const, verdict: 'non_abouti' as const },
);
const crm = (referer: string | null, workspace?: string) =>
  autoriserFenetre({ app: 'crm', referer, workspace, hubUserId: 'hub-robert' }, { espaceDe, workspaceDeLOrigine });

describe('autoriserFenetre, CRM : espace trouvé par l\'origine de l\'hôte', () => {
  it('origine absente (Referer coupé) : refus, rien n\'est demandé', async () => {
    workspaceDeLOrigine.mockClear();
    expect(await crm(null)).toEqual({ ok: false, refus: 'hote_absent' });
    expect(await crm('pas une url')).toEqual({ ok: false, refus: 'hote_absent' });
    expect(workspaceDeLOrigine).not.toHaveBeenCalled();
  });

  it('origine étrangère : un espace Twenty dont Robert n\'est pas membre, refus', async () => {
    expect(await crm('https://pirate.crm.app.veridian.site/objects/notes')).toEqual({ ok: false, refus: 'espace_etranger' });
  });

  it('origine étrangère : workspace= de Robert depuis la page d\'un autre espace, refus', async () => {
    expect(await crm('https://pirate.crm.app.veridian.site/', WS_ROBERT)).toEqual({ ok: false, refus: 'origine_etrangere' });
  });

  it('plugin muet ou origine hors du CRM : refus (fermé par défaut), jamais un espace par défaut', async () => {
    expect(await crm('https://inconnu.crm.app.veridian.site/')).toEqual({ ok: false, refus: 'non_abouti' });
  });

  it('Robert dans son espace CRM : ouvert, avec l\'origine vérifiée', async () => {
    expect(await crm('https://robert.crm.app.veridian.site/objects/companies')).toEqual({ ok: true, espace: espaceRobert, origine: 'https://robert.crm.app.veridian.site' });
  });
});

describe('autoriserFenetre, Academy', () => {
  it('le tenant doit être à l\'utilisateur ; sans tenant, refus', async () => {
    const parTenant = vi.fn(async (_u: string, t: unknown) => (t === 'tenant-robert' ? { id: 'tenant-robert', slug: 'r', workspaceId: null } : null));
    expect((await autoriserFenetre({ app: 'academy', tenant: 'tenant-autre', hubUserId: 'hub-robert' }, { espaceDe: parTenant })).ok).toBe(false);
    expect((await autoriserFenetre({ app: 'academy', hubUserId: 'hub-robert' }, { espaceDe: parTenant })).ok).toBe(false);
    expect((await autoriserFenetre({ app: 'academy', tenant: 'tenant-robert', hubUserId: 'hub-robert' }, { espaceDe: parTenant })).ok).toBe(true);
  });
});

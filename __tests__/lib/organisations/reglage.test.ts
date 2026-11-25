// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ ordre: [] as string[], retirer: vi.fn() }));
vi.mock('@/lib/organisations/emission', () => ({ emettreOrganisation: async () => { m.ordre.push('emettre'); return []; } }));
vi.mock('@/lib/organisations/decocher', () => ({ retirerVenus: async (...a: unknown[]) => { m.ordre.push('retirer'); return m.retirer(...a); } }));

import { Reglage, reglerOrganisation } from '@/lib/organisations/reglage';

import { base } from './fausse';

let db: ReturnType<typeof base>;
beforeEach(() => { m.ordre.length = 0; m.retirer.mockReset().mockResolvedValue([]); db = base(); db.tenant.lignes.push({ id: 'A', userId: 'p' }); });
const regler = (reglage: object, logo?: Buffer | null, tenantId = 'A') => reglerOrganisation(db as never, { tenantId, reglage: Reglage.parse(reglage), logo, acteur: 'user:p' });

describe('Reglage', () => {
  it('refuse une couleur, un module ou un champ inconnu', () => {
    for (const x of [{ couleur_primaire: 'red' }, { couleur_accent: '#12' }, { couleur_primaire: 'url(x)' }, { modules: ['cms'] }, { type: 'autre' }, { nom_affiche: '' }, { pirate: 1 }, { reglages: { cms: {} } }]) expect(Reglage.safeParse(x).success, JSON.stringify(x)).toBe(false);
    expect(Reglage.safeParse({ type: 'organisation', couleur_primaire: '#0b5FFF', modules: ['academy'], reglages: { academy: { mode_opco: true } } }).success).toBe(true);
  });
});
it('Reglage : une seule app suffit, les autres restent intactes ; les trois ensemble aussi', () => {
  expect(Reglage.safeParse({ reglages: { notifuse: { x: 1 } } }).success).toBe(true);
  expect(Reglage.safeParse({ modules: ['academy', 'notifuse', 'prospection'], reglages: { academy: {}, notifuse: {}, prospection: {} } }).success).toBe(true);
});
describe('reglerOrganisation', () => {
  it('n\'écrit que les champs donnés, et journalise sans le contenu du logo', async () => {
    await regler({ type: 'organisation', couleur_primaire: '#0B5FFF', modules: ['academy', 'academy'] });
    await regler({ nom_affiche: 'Atelier' });
    expect(db.organisation.lignes[0]).toMatchObject({ type: 'organisation', couleurPrimaire: '#0B5FFF', modules: ['academy'], nomAffiche: 'Atelier' });
    expect(db.auditLog.lignes).toHaveLength(2);
  });
  it('logo refusé : rien n\'est écrit ; tenant inconnu : rien', async () => {
    expect(await regler({ type: 'organisation' }, Buffer.from('<svg/>'))).toEqual({ refus: 'format_refuse' });
    expect(await regler({ type: 'organisation' }, undefined, 'Z')).toEqual({ refus: 'tenant_introuvable' });
    expect(db.organisation.lignes).toEqual([]);
  });
  it('décocher retire avant d\'émettre, et le dit ; recocher rouvre ceux venus par elle ; un réglage sans modules ne change pas les cases', async () => {
    const n = { tenantId: 'A', app: 'crm', hubUserId: 'u', origine: 'organisation', retireLe: null as Date | null, rejointLe: undefined as Date | undefined };
    db.organisationAcces.lignes.push(n);
    await regler({ modules: ['crm', 'prospection'] });
    n.rejointLe = undefined;
    await regler({ nom_affiche: 'X' });
    expect(m.retirer.mock.calls.at(-1)![2], 'cases inchangées').toEqual(['crm', 'prospection']);
    expect(n.rejointLe, 'toujours cochée : rien ne se rouvre').toBeUndefined();
    m.retirer.mockResolvedValue([{ app: 'crm', hub_user_id: 'u', etat: 'retire' }]);
    m.ordre.length = 0;
    expect(await regler({ modules: ['prospection'] })).toEqual({ emissions: [], retraits: [{ app: 'crm', hub_user_id: 'u', etat: 'retire' }] });
    expect(m.ordre).toEqual(['retirer', 'emettre']);
    n.retireLe = new Date(0);
    await regler({ modules: ['crm'] });
    expect([n.retireLe, n.rejointLe]).toEqual([null, expect.any(Date)]);
  });
  it('logo nul : retiré', async () => {
    await regler({});
    Object.assign(db.organisation.lignes[0], { logo: new Uint8Array([1]), logoEmpreinte: 'x' });
    await regler({}, null);
    expect(db.organisation.lignes[0]).toMatchObject({ logo: null, logoEmpreinte: null });
  });
});

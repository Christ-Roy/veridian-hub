// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { contenuOrg } from '@/lib/organisations/document';
import { organisationsEnRetard } from '@/lib/sync/organisations';

const T0 = new Date('2026-01-01');
let org: Record<string, any>[];
let emis: Record<string, any>[];
let tenantStatus: string;
// Lecture seule : aucune écriture n'existe sur ces tables. Une écriture ferait échouer le relevé.
const db = {
  organisation: { findMany: async () => org.map((o) => ({ tenantId: o.tenantId })), findUnique: async ({ where }: any) => org.find((o) => o.tenantId === where.tenantId) ?? null },
  organisationEmission: { findMany: async ({ where }: any) => emis.filter((e) => e.tenantId === where.tenantId) },
  tenant: { findFirst: async () => ({ id: 'A', userId: 'prop', name: 'Atelier', status: tenantStatus, createdAt: T0 }) },
  tenantMember: { findMany: async () => [] },
  user: { findMany: async () => [{ supabaseUserId: 'prop', email: 'prop@x.fr', name: null, emailVerified: T0 }] },
} as any;
const ENV = { AUTH_URL: 'https://hub.test' } as NodeJS.ProcessEnv;

/** Pose l'empreinte stockée et la version comme si l'organisation venait d'être émise. */
async function aJour(modules = ['academy']) {
  org = [{ tenantId: 'A', modules, nomAffiche: null, couleurPrimaire: null, couleurAccent: null, logoEmpreinte: null, reglages: {}, type: 'individuel', version: 5n, empreinte: null }];
  const c = (await contenuOrg(db, 'A', 'https://hub.test'))!;
  org[0].empreinte = c.empreinte;
  emis = [{ tenantId: 'A', app: 'academy', version: 5n, etat: 'applique' }];
}

beforeEach(() => { tenantStatus = 'active'; org = []; emis = []; });

describe('organisationsEnRetard', () => {
  it('à jour (version émise, état applique, contenu identique) : rien', async () => {
    await aJour();
    expect(await organisationsEnRetard(db, ENV)).toEqual([]);
  });
  it('une app cochée sans émission, ou non applique, ou sur une autre version, ou un contenu non encore versionné', async () => {
    await aJour();
    emis = [];
    expect(await organisationsEnRetard(db, ENV)).toEqual([expect.objectContaining({ hub_tenant_id: 'A', app: 'academy', raison: 'pas_d_emission' })]);
    emis = [{ tenantId: 'A', app: 'academy', version: 5n, etat: 'echec' }];
    expect(await organisationsEnRetard(db, ENV)).toEqual([expect.objectContaining({ raison: 'etat_non_applique', etat: 'echec' })]);
    emis = [{ tenantId: 'A', app: 'academy', version: 4n, etat: 'applique' }];
    expect(await organisationsEnRetard(db, ENV)).toEqual([expect.objectContaining({ raison: 'version_differente' })]);
    emis = [{ tenantId: 'A', app: 'academy', version: 5n, etat: 'applique' }];
    org[0].empreinte = 'ancienne';
    expect(await organisationsEnRetard(db, ENV)).toEqual([expect.objectContaining({ raison: 'contenu_non_emis' })]);
  });
  it('une app non cochée, ou une organisation suspendue : rien n\'est compté', async () => {
    await aJour([]);
    expect(await organisationsEnRetard(db, ENV)).toEqual([]);
    await aJour();
    emis = [];
    tenantStatus = 'suspended';
    expect(await organisationsEnRetard(db, ENV)).toEqual([]);
  });
  it('ne rend aucune adresse, et n\'écrit rien (relevé seul)', async () => {
    await aJour();
    emis = [];
    const r = await organisationsEnRetard(db, ENV);
    expect(JSON.stringify(r)).not.toContain('@');
    expect(r).toHaveLength(1);
  });
});

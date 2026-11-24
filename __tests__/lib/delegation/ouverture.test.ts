// @vitest-environment node
/** `crm@test` : ouvert aux organisations d'un compte de test, et à elles seules, de bout en bout. */
import { exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { confirmerDemande, listerIntegrations, reglerIntegration } from '@/lib/delegation/interrupteur';
import { echanger, oublierDebit } from '@/lib/delegation/jeton';
import { organisationDeTest } from '@/lib/delegation/ouverture';
import { empreintePortees, paire } from '@/lib/delegation/paires';
import { emettrePoignees } from '@/lib/delegation/poignee';

import { base } from './fausse';

const P = paire('prospection>crm')!;
let ENV: NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
beforeEach(async () => {
  oublierDebit();
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  ENV = { NODE_ENV: 'test', DELEGATION_CIBLES: 'crm@test', MCP_SIGNING_JWK: JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'k1' }) };
  db = base();
  db.tenant.lignes.push({ id: 'T', userId: 't', status: 'active' }, { id: 'C', userId: 'c', status: 'active' });
  db.user.lignes.push({ supabaseUserId: 't', email: 'e2e-sso-x-prop@veridian.site', emailVerified: new Date() }, { supabaseUserId: 'c', email: 'client@x.fr', emailVerified: new Date() });
  // Le compte de test est aussi membre chez le client : c'est l'organisation qui compte, pas la personne.
  db.tenantMember.lignes.push({ tenantId: 'C', userId: 't', role: 'admin' });
  db.mcpApp.lignes.push({ appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true, acces: 'tous' });
});
const etat = async (id: string) => (await listerIntegrations(db as never, id, ENV)).find((x) => x.paire === P.cle)!.etat;
const regler = (tenantId: string, hubUserId: string) => reglerIntegration(db as never, { tenantId, paire: P.cle, etat: 'allumee', hubUserId, client: 'x', origine: 'https://hub.test' }, ENV);

describe('organisationDeTest', () => {
  it('le propriétaire fait foi ; sans @test dans l\'environnement, jamais', async () => {
    const o = (id: string, cibles = 'crm@test') => organisationDeTest(db as never, id, { NODE_ENV: 'test', DELEGATION_CIBLES: cibles });
    expect(await Promise.all([o('T'), o('C'), o('inconnu'), o('T', 'crm'), o('T', '')])).toEqual([true, false, false, false, false]);
  });
  it('un client ne voit, ne règle, ne reçoit et n\'échange rien ; le compte de test, si', async () => {
    expect([await etat('T'), await etat('C')]).toEqual(['eteinte', 'indisponible']);
    expect(await regler('C', 'c')).toEqual({ refus: 'cible_non_servie' });
    const r = (await regler('T', 't')) as { lien: string };
    expect((await confirmerDemande(db as never, r.lien.split('/').pop()!, 't', ENV)).ok).toBe(true);
    expect(await emettrePoignees(db as never, { hubUserId: 'c', app: 'prospection' }, ENV)).toEqual([]);
    const g = await emettrePoignees(db as never, { hubUserId: 't', app: 'prospection' }, ENV);
    expect(g.map((x) => x.hub_tenant_id), 'pas celle du client dont il est membre').toEqual(['T']);
    const demander = (grant: string) => echanger(db as never, 'prospection', { subject_grant: grant, audience: 'crm', scope: 'crm:tache.ecrire' }, ENV);
    expect(await demander(g[0].grant)).toMatchObject({ tenantId: 'T', expiresIn: 120 });

    // Une poignée du client, émise quand tout était ouvert, ne s'échange plus une fois refermé aux comptes de test.
    const ouvert = { ...ENV, DELEGATION_CIBLES: 'crm' };
    const gc = await emettrePoignees(db as never, { hubUserId: 'c', app: 'prospection' }, ouvert);
    db.integrationPaire.lignes.push({ tenantId: 'C', paire: P.cle, etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(P), changePar: 'c', changeLe: new Date() });
    expect(await echanger(db as never, 'prospection', { subject_grant: gc[0].grant, audience: 'crm', scope: 'crm:tache.ecrire' }, ouvert)).toMatchObject({ tenantId: 'C' });
    expect(await demander(gc[0].grant)).toEqual({ statut: 403, error: 'target_not_served' });
  });
});

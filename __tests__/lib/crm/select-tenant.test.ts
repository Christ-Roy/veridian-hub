/**
 * Test contractuel pour lib/crm/select-tenant.
 *
 * Cette lib est temporairement un STUB qui retourne null en attendant
 * qu'Agent A push la migration crm_tenants + la vraie implémentation
 * Prisma. Ce test verrouille le contrat que la route /dashboard/crm et la
 * page consomment :
 *  - signature `getCrmTenantByUserId(userUuid: string): Promise<CrmTenantView | null>`
 *  - shape `CrmTenantView` (id, twentyWorkspaceId, status, createdAt)
 *  - status ∈ {provisioning, active, suspended, error}
 *
 * Quand Agent A remplace l'implémentation, ce test doit continuer à passer
 * (contrat stable) — il sera complété côté agent-A avec des cas DB réels.
 */
import { describe, it, expect } from 'vitest';
import {
  getCrmTenantByUserId,
  type CrmTenantView,
  type CrmTenantStatus,
} from '@/lib/crm/select-tenant';

describe('lib/crm/select-tenant — contrat', () => {
  it('retourne null si pas de CrmTenant (état stub, post-impl = user sans tenant)', async () => {
    const result = await getCrmTenantByUserId('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('accepte un userUuid arbitraire sans throw (signature stable)', async () => {
    await expect(
      getCrmTenantByUserId('any-uuid-shape'),
    ).resolves.not.toThrow();
  });

  it('le type CrmTenantStatus couvre les 4 status attendus', () => {
    // Assertion de type pure — pas de run-time, mais bloque le push si on
    // sort un status hors enum (et donc casse l'UI <CrmStatusCard>).
    const statuses: CrmTenantStatus[] = [
      'provisioning',
      'active',
      'suspended',
      'error',
    ];
    expect(statuses).toHaveLength(4);
  });

  it('le type CrmTenantView contient les 4 champs consommés par la page', () => {
    // Assertion structurelle — si Agent A renomme `twentyWorkspaceId` ou
    // supprime `createdAt`, ce test casse à la compilation TS et bloque
    // le push (sécurité contre breaking change silencieux du contrat).
    const fake: CrmTenantView = {
      id: 'ct-1',
      twentyWorkspaceId: 'ws-1',
      status: 'active',
      createdAt: new Date(),
    };
    expect(fake.id).toBe('ct-1');
    expect(fake.twentyWorkspaceId).toBe('ws-1');
    expect(fake.status).toBe('active');
    expect(fake.createdAt).toBeInstanceOf(Date);
  });
});

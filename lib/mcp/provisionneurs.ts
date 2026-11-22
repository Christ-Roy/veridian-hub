/**
 * Création du compte d'un utilisateur dans une app, quand son MCP répond `hub_user_unknown`. Le Hub
 * provisionne déjà ces comptes (activation, première ouverture par le rebond) : la porte réutilise
 * exactement le même chemin, elle n'en invente pas. Une app sans provisionneur au Hub crée ses comptes
 * à la première ouverture depuis l'espace Veridian.
 */
import type { Appelant } from './oauth';

export type Provisionneur = (qui: Appelant) => Promise<boolean>;

export async function provisionneursParDefaut(): Promise<Record<string, Provisionneur>> {
  const [{ prisma }, { ensureCrmWorkspace }, { ensureAcademyWorkspace }] = await Promise.all([
    import('@/lib/prisma'),
    import('@/lib/crm/provision'),
    import('@/lib/academy/provision'),
  ]);
  return {
    twenty: async (qui) =>
      (await ensureCrmWorkspace(prisma, { hubUserId: qui.hubUserId, email: qui.email, name: qui.name }, { actorEmail: `mcp:${qui.clientId}` })).ok,
    // Le catalogue n'offre Academy qu'aux comptes activés (`acces: tenant_app`) : la porte ne crée
    // donc un espace que pour eux.
    academy: async (qui) =>
      (await ensureAcademyWorkspace(prisma, { hubUserId: qui.hubUserId, email: qui.email, name: qui.name }, { actorEmail: `mcp:${qui.clientId}` })).ok,
  };
}

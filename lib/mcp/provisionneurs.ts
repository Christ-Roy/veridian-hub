/**
 * Création du compte d'un utilisateur dans une app, quand son MCP répond `hub_user_unknown`. Le Hub
 * provisionne déjà ces comptes (activation, première ouverture par le rebond) : la porte réutilise
 * exactement le même chemin, elle n'en invente pas. Une app sans provisionneur au Hub crée ses comptes
 * à la première ouverture depuis l'espace Veridian.
 */
import type { Appelant } from './oauth';

export type Provisionneur = (qui: Appelant) => Promise<boolean>;

export async function provisionneursParDefaut(): Promise<Record<string, Provisionneur>> {
  const [{ prisma }, { ensureCrmWorkspace }] = await Promise.all([import('@/lib/prisma'), import('@/lib/crm/provision')]);
  return {
    twenty: async (qui) =>
      (await ensureCrmWorkspace(prisma, { hubUserId: qui.hubUserId, email: qui.email, name: qui.name }, { actorEmail: `mcp:${qui.clientId}` })).ok,
  };
}

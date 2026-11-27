/**
 * L'organisation active d'un compte (VER-252) : choisie au Hub, gardée dans un cookie, REVÉRIFIÉE à chaque usage. Le cookie n'est qu'un
 * souhait : il ne donne aucun droit. Une seule organisation vivante : c'est elle, sans rien choisir.
 */
import type { Preuve } from '@/lib/federation/obligation';
import { espacesDe, type DbEspaces } from '@/lib/mcp/catalogue';

export const COOKIE_ACTIF = 'veridian_org';

export async function organisationActive(db: DbEspaces, hubUserId: string, preuve: Preuve, souhait: string | undefined): Promise<string | null> {
  const vivants = await espacesDe(db, hubUserId, preuve);
  if (souhait && vivants.some((e) => e.id === souhait)) return souhait;
  return vivants.length === 1 ? vivants[0].id : null;
}

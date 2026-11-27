/**
 * Écrire une partie de `tenants.metadata` sans effacer le reste : une fusion faite PAR LA BASE (`metadata || patch`), jamais une
 * réécriture du JSON entier à partir d'une lecture faite avant. Le 26/11 à 14:22, l'avis « suspendu » de Mail, traité pendant la
 * suspension, a réécrit metadata depuis une lecture périmée : la note `hub_suspension` a disparu, et la reprise n'a rien rouvert chez
 * Prospection (espace resté fermé). Toute écriture partielle de metadata passe par ici.
 */
import { Prisma, type PrismaClient } from '@prisma/client';

type DbBrute = Pick<PrismaClient, '$executeRaw'>;

/** Pose ces clés de premier niveau ; les autres restent telles que la base les a à cet instant. Rend le nombre de lignes changées (0 : tenant absent). */
export async function fusionnerMetadata(db: DbBrute, tenantId: string, patch: Record<string, unknown>): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE hub_app.tenants
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, updated_at = now()
    WHERE id = ${tenantId}::uuid
  `);
}

/** Retire ces clés de premier niveau, sans toucher aux autres. */
export async function retirerDeMetadata(db: DbBrute, tenantId: string, cles: string[]): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE hub_app.tenants
    SET metadata = COALESCE(metadata, '{}'::jsonb) - ${cles}::text[], updated_at = now()
    WHERE id = ${tenantId}::uuid
  `);
}

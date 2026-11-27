/** Aucune organisation n'exige son fournisseur : ce que la garde (lib/federation/obligation.ts) lit dans les tests qui ne parlent pas d'elle. */
export const LIBRE = {
  tenantConnexion: { findMany: async () => [] as { tenantId: string }[], findFirst: async () => null, findUnique: async () => null },
  connexionExemption: { findUnique: async () => null, findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  connexionPreuve: { findUnique: async () => null, upsert: async () => ({}) },
};

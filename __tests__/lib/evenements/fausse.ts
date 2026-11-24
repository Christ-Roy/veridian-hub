/** Base en mémoire pour les événements : plusieurs contraintes d'unicité (comme la vraie), `OR`, `gt`/`lt`, clés composées aplaties. */
import { generateKeyPair, exportJWK } from 'jose';

type L = Record<string, any>;
const ok = (l: L, w: L = {}): boolean => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return (v as L[]).some((x) => ok(l, x));
  if (/_/.test(k) && v && typeof v === 'object' && !(v instanceof Date) && !('gt' in v) && !('lt' in v)) return ok(l, v);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('gt' in v) return l[k] > v.gt;
    if ('lt' in v) return l[k] < v.lt;
  }
  return v === null ? l[k] === null || l[k] === undefined : l[k] === v;
});
export function table(uniques: string[][] = []) {
  const lignes: L[] = [];
  let n = 0;
  const conflit = (d: L, sauf?: L) => uniques.some((u) => u.every((c) => d[c] != null) && lignes.some((x) => x !== sauf && u.every((c) => x[c] === d[c])));
  return {
    lignes,
    create: async ({ data }: L) => { if (conflit(data)) throw new Error('unique'); const l = { id: `l${++n}`, etat: 'pris', prisLe: new Date(), ecritLe: new Date(), ...data }; lignes.push(l); return l; },
    findUnique: async ({ where }: L) => lignes.find((x) => ok(x, where)) ?? null,
    findFirst: async ({ where }: L) => lignes.find((x) => ok(x, where)) ?? null,
    count: async ({ where }: L) => lignes.filter((x) => ok(x, where)).length,
    updateMany: async ({ where, data }: L) => { const r = lignes.filter((x) => ok(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
    deleteMany: async ({ where }: L) => { const r = lignes.filter((x) => ok(x, where)); r.forEach((x) => lignes.splice(lignes.indexOf(x), 1)); return { count: r.length }; },
    upsert: async ({ where, create, update }: L) => { const l = lignes.find((x) => ok(x, where)); if (l) return Object.assign(l, update); const c = { id: `l${++n}`, ...create }; lignes.push(c); return c; },
  };
}
export const base = () => ({ evenementAbonnement: table(), evenementRecu: table([['source', 'evenementId'], ['source', 'messageId'], ['source', 'cleRfc']]), integrationLien: table(), integrationPause: table(), integrationPaire: table(), tenant: table(), tenantMember: table(), mcpApp: table(), auditLog: table() });
export const cleDeTest = async (): Promise<NodeJS.ProcessEnv> => ({ NODE_ENV: 'test', VAULT_ENC_KEY: 'k'.repeat(40), MCP_SIGNING_JWK: JSON.stringify({ ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'k1' }) });

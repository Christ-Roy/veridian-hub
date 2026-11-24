/** Base en mémoire pour la délégation : seulement ce que lib/delegation utilise. */
type L = Record<string, any>;
const ok = (l: L, w: L = {}): boolean => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return (v as L[]).some((x) => ok(l, x));
  if (k === 'tenantId_paire' || k === 'tenantId_userId') return ok(l, v);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('gt' in v) return l[k] > v.gt;
    if ('lt' in v) return l[k] < v.lt;
    if ('in' in v) return v.in.includes(l[k]);
    if ('notIn' in v) return !v.notIn.includes(l[k]);
  }
  return v === null ? l[k] === null || l[k] === undefined : l[k] === v;
});
export function table(unique: string[] = []) {
  const lignes: L[] = [];
  let n = 0;
  return {
    lignes,
    create: async ({ data }: L) => { if (unique.length && lignes.some((x) => unique.every((u) => x[u] === data[u]))) throw new Error('unique'); const l = { id: `l${++n}`, creeLe: new Date(Date.now() + n), changeLe: new Date(), ...data }; lignes.push(l); return l; },
    findUnique: async ({ where }: L) => lignes.find((x) => ok(x, where)) ?? null,
    findFirst: async ({ where }: L) => lignes.find((x) => ok(x, where)) ?? null,
    findMany: async ({ where, orderBy }: L = {}) => { const r = lignes.filter((x) => ok(x, where)); return orderBy?.creeLe === 'desc' ? r.sort((a, b) => b.creeLe - a.creeLe) : r; },
    updateMany: async ({ where, data }: L) => { const r = lignes.filter((x) => ok(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
    deleteMany: async ({ where }: L) => { const r = lignes.filter((x) => ok(x, where)); r.forEach((x) => lignes.splice(lignes.indexOf(x), 1)); return { count: r.length }; },
    upsert: async ({ where, create, update }: L) => { const l = lignes.find((x) => ok(x, where)); if (l) return Object.assign(l, update); const c = { changeLe: new Date(), ...create }; lignes.push(c); return c; },
  };
}
export const base = () => ({ delegationGrant: table(['empreinte']), delegationNonce: table(['empreinte']), integrationPaire: table(), integrationDemande: table(['empreinte']), tenant: table(), tenantMember: table(), user: table(), mcpApp: table(), tenantApp: table(), auditLog: table() });

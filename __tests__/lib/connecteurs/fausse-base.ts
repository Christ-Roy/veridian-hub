/** Base en mémoire des connexions : les opérations que lib/connecteurs utilise, avec la comparaison des valeurs (c'est elle qui tient les croisements). */
type L = Record<string, any>;
const egal = (a: any, v: any) => (v && typeof v === 'object' && 'lt' in v ? a != null && a < v.lt : (a ?? null) === (v ?? null));
const tient = (x: L, w: L = {}): boolean => Object.entries(w).every(([k, v]) => (k === 'OR' ? (v as L[]).some((o) => tient(x, o)) : egal(x[k], v)));
const cles = (w: L): L => Object.values(w).reduce((a: L, v) => (v && typeof v === 'object' && !(v instanceof Date) ? { ...a, ...v } : a), Object.fromEntries(Object.entries(w).filter(([, v]) => !v || typeof v !== 'object')));
let n = 0;
function table(uniques: string[], defauts: () => L = () => ({})) {
  let l: L[] = [];
  return {
    get lignes() { return l; },
    vider: () => { l = []; },
    findMany: async ({ where }: L = {}) => l.filter((x) => tient(x, where)).map((x) => ({ ...x })),
    findUnique: async ({ where }: L) => { const x = l.find((y) => tient(y, cles(where))); return x ? { ...x } : null; },
    create: async ({ data }: L) => {
      const x = { ...defauts(), ...data };
      if (l.some((y) => uniques.every((u) => y[u] === x[u]))) throw Object.assign(new Error('doublon'), { code: 'P2002' });
      l.push(x);
      return { ...x };
    },
    createMany: async ({ data }: L) => { for (const x of data) if (!l.some((y) => uniques.every((u) => y[u] === x[u]))) l.push({ ...defauts(), ...x }); },
    updateMany: async ({ where, data }: L) => { const r = l.filter((x) => tient(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
    deleteMany: async ({ where }: L) => { const avant = l.length; l = l.filter((x) => !tient(x, where)); return { count: avant - l.length }; },
  };
}
export const fausseBaseConnexions = () => ({
  connecteurClient: table(['connecteur', 'retour'], () => ({ secretChiffre: null, gestionChiffre: null })),
  connexionExterne: table(['hubUserId', 'connecteur'], () => ({ id: `c${(n += 1)}`, creeLe: new Date('2026-11-25T10:00:00Z'), refreshChiffre: null, ecriture: false, compte: null, attenteChiffre: null, attenteCompte: null, renouvellementLe: null })),
  connecteurOutilVu: table(['connecteur', 'empreinte']),
  user: { absents: new Set<string>(), findUnique: async function ({ where }: L) { return this.absents.has(where.supabaseUserId) ? null : { id: 'U' }; }, vider() { this.absents.clear(); } },
});

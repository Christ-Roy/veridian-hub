/**
 * Signature TypeScript d'un outil, générée depuis son inputSchema JSON, pour que l'IA écrive son programme
 * (`executer_programme`) en sachant ce qu'elle appelle. Pur, ne lève jamais : un schéma illisible devient `unknown`.
 * Le schéma vient d'une app (donc d'un tiers) : rien n'en sort hors d'un commentaire sans être nettoyé (`*​/`, retours ligne).
 */

const TAILLE_MAX = 1500; // caractères par signature
const PROFONDEUR_MAX = 3;
const PROPS_MAX = 40;
const UNION_MAX = 8;
const DESC_MAX = 60;
const LITTERAL_MAX = 40;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type Schema = Record<string, unknown>;
type Opt = { desc: boolean; prof: number };

const estObjet = (x: unknown): x is Schema => !!x && typeof x === 'object' && !Array.isArray(x);

/** Une ligne, sans fin de commentaire ni séparateur de ligne Unicode, bornée. */
function propre(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function litteral(v: unknown): string | null {
  if (typeof v === 'string') return JSON.stringify(propre(v, LITTERAL_MAX));
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  return null;
}

function union(parts: string[]): string {
  const u = [...new Set(parts)];
  if (u.includes('unknown')) return 'unknown';
  return u.slice(0, UNION_MAX).join(' | ') + (u.length > UNION_MAX ? ' | unknown' : '');
}

const PRIMITIFS: Record<string, string> = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', null: 'null' };

function typeDe(s: unknown, o: Opt, prof: number): string {
  if (!estObjet(s)) return 'unknown';
  if ('const' in s) return litteral(s.const) ?? 'unknown';
  if (Array.isArray(s.enum)) {
    const l = s.enum.slice(0, 12).map(litteral);
    return l.length && !l.includes(null) ? union(l as string[]) + (s.enum.length > 12 ? ' | string' : '') : 'unknown';
  }
  for (const k of ['oneOf', 'anyOf'] as const) {
    const v = s[k];
    if (Array.isArray(v) && v.length) return union(v.slice(0, UNION_MAX + 1).map((x) => typeDe(x, o, prof)));
  }
  const t = s.type;
  if (Array.isArray(t)) return union(t.map((x) => typeDe({ ...s, type: x }, o, prof)));
  const nul = s.nullable === true ? ' | null' : '';
  if (typeof t === 'string' && PRIMITIFS[t]) return PRIMITIFS[t] + nul;
  if (t === 'array') {
    const e = typeDe(s.items, o, prof);
    return (/[|{]/.test(e) ? `(${e})` : e) + '[]' + nul;
  }
  if (t === 'object' || (t === undefined && estObjet(s.properties))) {
    if (!estObjet(s.properties) || Object.keys(s.properties).length === 0) return (s.additionalProperties === false ? '{}' : 'Record<string, unknown>') + nul;
    if (prof >= o.prof) return 'object' + nul;
    const req = new Set(Array.isArray(s.required) ? s.required.filter((x) => typeof x === 'string') : []);
    const noms = Object.keys(s.properties);
    const champs = noms.slice(0, PROPS_MAX).map((n) => {
      const p = (s.properties as Schema)[n];
      const cle = IDENT.test(n) ? n : JSON.stringify(propre(n, 60));
      return `${cle}${req.has(n) ? '' : '?'}: ${typeDe(p, o, prof + 1)}${note(p, o)}`;
    });
    if (noms.length > PROPS_MAX) champs.push(`/* +${noms.length - PROPS_MAX} autres */`);
    return `{ ${champs.join('; ')} }${nul}`;
  }
  return 'unknown';
}

/** Commentaire d'un champ : description courte et bornes. Jamais plus d'une ligne. */
function note(p: unknown, o: Opt): string {
  if (!estObjet(p)) return '';
  const bits: string[] = [];
  const lo = typeof p.minimum === 'number' ? p.minimum : undefined;
  const hi = typeof p.maximum === 'number' ? p.maximum : undefined;
  if (lo !== undefined || hi !== undefined) bits.push(`${lo ?? ''}..${hi ?? ''}`);
  if (typeof p.default === 'number' || typeof p.default === 'boolean' || (typeof p.default === 'string' && p.default.length <= 20)) bits.push(`défaut ${litteral(p.default)}`);
  if (o.desc && typeof p.description === 'string' && p.description.trim()) bits.push(propre(p.description, DESC_MAX));
  return bits.length ? ` /* ${bits.join('; ')} */` : '';
}

/**
 * `outil("app.nom", { a: string; b?: number /​* 1..10 *​/ }): Promise<unknown>` ; `autorisation` ajoute « à nommer dans autoriser ».
 * La taille est bornée : si le schéma est trop gros, on perd d'abord les descriptions, puis la profondeur.
 */
export function signatureOutil(nom: string, schema: unknown, autorisation: boolean): string {
  const fin = `Promise<unknown>${autorisation ? ' // à nommer dans autoriser' : ''}`;
  const tete = `outil(${JSON.stringify(propre(nom, 120))}, `;
  const essais: Opt[] = [{ desc: true, prof: PROFONDEUR_MAX }, { desc: false, prof: PROFONDEUR_MAX }, { desc: false, prof: 1 }, { desc: false, prof: 0 }];
  try {
    for (const o of essais) {
      const corps = typeDe(estObjet(schema) && !('type' in schema) && estObjet(schema.properties) ? { ...schema, type: 'object' } : schema, o, 0);
      const sig = `${tete}${corps}): ${fin}`;
      if (sig.length <= TAILLE_MAX) return sig;
    }
  } catch {
    /* schéma illisible ou piégé : unknown */
  }
  return `${tete}unknown): ${fin}`;
}

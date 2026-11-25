import { describe, expect, it } from 'vitest';

import { signatureOutil } from '@/lib/mcp/signature';

const sig = (s: unknown, auto = false) => signatureOutil('prospection.extraire_segment', s, auto);

describe('signatureOutil', () => {
  it('cas canonique : requis, optionnel, bornes, mention autoriser', () => {
    const r = sig({ type: 'object', properties: { segment_id: { type: 'string' }, curseur: { type: 'string' }, limite: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['segment_id'] }, true);
    expect(r).toBe('outil("prospection.extraire_segment", { segment_id: string; curseur?: string; limite?: number /* 1..1000 */ }): Promise<unknown> // à nommer dans autoriser');
  });
  it('lecture seule : pas de mention', () => expect(sig({ type: 'object', properties: {} })).not.toContain('autoriser'));
  it('enum, const, oneOf, anyOf, nullable, type multiple', () => {
    const r = sig({ type: 'object', required: ['a'], properties: {
      a: { enum: ['x', 'y', 3] }, b: { const: 'k' }, c: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      d: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }, e: { type: 'string', nullable: true }, f: { type: ['string', 'null'] },
    } });
    expect(r).toContain('a: "x" | "y" | 3;');
    expect(r).toContain('b?: "k"');
    expect(r).toContain('c?: string | number');
    expect(r).toContain('d?: boolean | null');
    expect(r).toContain('e?: string | null');
    expect(r).toContain('f?: string | null');
  });
  it('tableaux et objets imbriqués, profondeur bornée', () => {
    expect(sig({ type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, u: { type: 'array', items: { type: ['string', 'number'] } } } })).toContain('ids?: string[]; u?: (string | number)[]');
    const prof = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'string' } } } } } } } } } } };
    const r = sig(prof);
    expect(r).toContain('object');
    expect(r).not.toContain('e?:');
  });
  it('noms non identifiants entre guillemets', () => {
    expect(sig({ type: 'object', properties: { 'a-b': { type: 'string' }, '1x': { type: 'string' } } })).toContain('"a-b"?: string; "1x"?: string');
  });
  it('description courte en commentaire', () => {
    expect(sig({ type: 'object', properties: { q: { type: 'string', description: 'Recherche libre' } } })).toContain('q?: string /* Recherche libre */');
  });
  it('contenu hostile : jamais de fin de commentaire ni de retour ligne', () => {
    const r = sig({ type: 'object', properties: { 'x*/y\nz': { type: 'string', description: 'fin */ \n evil(); /* \u2028 // ' }, e: { enum: ['a*/\nb'] } } });
    expect(r).not.toMatch(/[\n\r\u2028\u2029]/);
    // tout commentaire ouvert est refermé une seule fois, et rien d'exécutable n'en sort
    for (const m of r.matchAll(/\/\*(.*?)\*\//g)) expect(m[1]).not.toContain('*/');
    expect(r.replace(/\/\*.*?\*\//g, '')).not.toContain('evil');
  });
  it('trop gros : borné, descriptions sacrifiées en premier', () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) props[`champ_${i}`] = { type: 'string', description: 'x'.repeat(200) };
    const r = sig({ type: 'object', properties: props });
    expect(r.length).toBeLessThanOrEqual(1500);
    expect(r).toContain('Promise<unknown>');
  });
  it.each([null, undefined, 42, 'x', [], { type: 'wat' }, {}, { type: 'object', properties: { a: null, b: 7 } }])('schéma illisible %#: unknown ou objet, sans exception', (s) => {
    expect(sig(s)).toMatch(/^outil\("prospection\.extraire_segment", .+\): Promise<unknown>/);
  });
  it('schéma cyclique : ne boucle pas', () => {
    const a: any = { type: 'object', properties: {} };
    a.properties.moi = a;
    expect(sig(a).length).toBeLessThanOrEqual(1500);
    const b: any = { type: 'array' };
    b.items = b;
    expect(() => sig(b)).not.toThrow();
  });
});

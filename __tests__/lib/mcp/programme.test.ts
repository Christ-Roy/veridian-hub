// @vitest-environment node
/**
 * Mode programme (docs/CONTRAT-MCP.md). Le vrai exécuteur QuickJS, en processus fils, pour ce que voit un programme ; des
 * moteurs menteurs pour ce que le Hub ne doit pas croire. L'enfermement (réseau, disque, /proc, uid) s'éprouve sur ce qui
 * est servi : scripts/epreuve-programme.sh.
 */
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppDebit, AppInjoignable } from '@/lib/mcp/client-app';
import type { Outil } from '@/lib/mcp/catalogue';
import {
  APPELS_MAX, APPELS_MINUTE_MAX, DE_FRONT, executerProgramme, exigeAutorisation, oublierProgrammes, prendrePlace, presenter, valeurDe,
  type Contenu, type DemandeProgramme, type Moteur,
} from '@/lib/mcp/programme';
import { enMoteur } from '@/lib/mcp/programme-moteur';

const outil = (nom: string, annotations?: Record<string, unknown>): Outil => ({ nom, app: nom.split('.')[0], local: nom.split('.')[1], description: '', inputSchema: {}, annotations });
const CATALOGUE = [outil('a.lire', { readOnlyHint: true }), outil('a.ecrire', { readOnlyHint: false, destructiveHint: false }), outil('a.supprimer', { destructiveHint: true }), outil('a.muet')];
const ok = (v: unknown): Contenu => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

/** Le vrai exécuteur, sans la prison. */
const vrai = async (_id: string, max: number): Promise<Moteur> => {
  const p = spawn(process.execPath, ['--max-old-space-size=96', 'programme/executeur.mjs'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const flux = Duplex.from({ readable: p.stdout, writable: p.stdin });
  flux.on('close', () => p.kill('SIGKILL'));
  return enMoteur(flux, max);
};
/** Un moteur compromis : il envoie ce qu'il veut. */
const menteur = (lignes: (string | Record<string, unknown>)[], recu: string[] = [], apres?: (m: Moteur, flux: PassThrough) => void) => async (_id: string, max: number): Promise<Moteur> => {
  const entree = new PassThrough();
  const flux = Duplex.from({ readable: entree, writable: new PassThrough() });
  const m = enMoteur(flux, max);
  const env = m.envoyer;
  m.envoyer = (x) => { recu.push(JSON.stringify(x)); env(x); };
  setTimeout(() => { for (const l of lignes) entree.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`); apres?.(m, entree); }, 5);
  return m;
};
const lancer = (code: string, o: Partial<DemandeProgramme> = {}) =>
  executerProgramme({
    id: 'p1', utilisateur: 'u', code, reprise: null, autoriser: new Set(), trouver: (n) => CATALOGUE.find((x) => x.nom === n),
    jouer: async (x, args) => ok({ outil: x.nom, args }), ouvrirMoteur: vrai, delaiMs: 20_000, ...o,
  });

beforeEach(() => {
  oublierProgrammes();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ce que voit un programme', () => {
  it('boucle sur un outil, ne rend que son résultat', async () => {
    const jouer = vi.fn(async (_o: Outil, a: Record<string, unknown>) => ok({ lignes: Number(a.page) < 3 ? [1, 2] : [] }));
    const b = await lancer('let n=0; for (let page=0;;page++){ const r=await outil("a.lire",{page}); if(!r.lignes.length) return {n, page}; n+=r.lignes.length; }', { jouer });
    expect(b).toMatchObject({ etat: 'termine', resultat: { n: 6, page: 3 }, appels: { faits: 4, reussis: 4, echoues: 0, issue_inconnue: [] } });
  });

  it('ni réseau, ni système, ni modules', async () => {
    const b = await lancer('return [typeof fetch, typeof process, typeof require, typeof Deno, typeof XMLHttpRequest, typeof setTimeout, typeof WebAssembly, typeof std, typeof os].join()');
    expect(b.resultat).toBe(Array(9).fill('undefined').join());
  });

  it('une erreur d\'outil est une exception rattrapable, avec son texte', async () => {
    const b = await lancer('try { await outil("a.lire") } catch (e) { return e.message }', { jouer: async () => ({ content: [{ type: 'text', text: 'page inconnue' }], isError: true }) });
    expect(b.resultat).toBe('page inconnue');
  });

  it('reprise : la valeur passée est lisible, la dernière sauvée est rendue', async () => {
    const b = await lancer('sauver({page: reprise.page + 1}); await outil("a.lire"); sauver({page: reprise.page + 2}); return 1', { reprise: { page: 4 } });
    expect(b.reprise).toEqual({ page: 6 });
  });

  it.each([
    ['boucle infinie', 'while(true){}', /interrupted/],
    ['récursion', 'const f=()=>f()+1; return f()', /stack/],
    ['trop de mémoire', 'return "x".repeat(2e8).length', /memory/],
    ['erreur de syntaxe', 'const =', /Syntax/],
    ['valeur circulaire', 'const a={}; a.a=a; return a', /circular/],
  ])('%s : erreur dite', async (_n, code, motif) => {
    const b = await lancer(code);
    expect(b.etat).toBe('erreur');
    expect(b.erreur).toMatch(motif);
  }, 30_000);
});

describe('bornes, tenues par le Hub', () => {
  it('échéance : état, reprise, appels d\'issue inconnue, jamais un silence ; les appels en vol sont abandonnés', async () => {
    let abandonnes = 0;
    const jouer = (_o: Outil, a: Record<string, unknown>, signal: AbortSignal) =>
      new Promise<Contenu>((r) => { if (Number(a.i) < 2) return r(ok(1)); signal.addEventListener('abort', () => { abandonnes += 1; }); });
    const b = await lancer('for (let i=0;;i++){ await outil("a.lire",{i}); sauver({i}); }', { jouer, delaiMs: 6_000 });
    expect(b).toMatchObject({ etat: 'interrompu', raison: 'delai', reprise: { i: 1 }, appels: { faits: 3, reussis: 2, issue_inconnue: ['a.lire'] } });
    expect(abandonnes).toBe(1);
    const t = presenter('p1', b);
    expect(t.isError).toBeUndefined();
    expect(t.content[0].text).toMatch(/relancer le même code avec reprise/);
  }, 15_000);

  it('échéance sans rien de sauvé : dit', async () => {
    const t = presenter('p', await lancer('await new Promise(()=>{})', { delaiMs: 1_500 }));
    expect(t.content[0].text).toMatch(/n'a rien sauvé/);
  }, 15_000);

  it(`${APPELS_MAX} appels, ${DE_FRONT} de front`, async () => {
    let enCours = 0;
    let pointe = 0;
    const jouer = async () => { pointe = Math.max(pointe, ++enCours); await new Promise((r) => setTimeout(r, 2)); enCours -= 1; return ok(1); };
    const b = await lancer(`let e; await Promise.all(Array.from({length:${APPELS_MAX + 20}},()=>outil("a.lire").catch(x=>{e=x.message}))); return e`, { jouer });
    expect(b.appels).toMatchObject({ faits: APPELS_MAX, reussis: APPELS_MAX, echoues: 20 });
    expect(pointe).toBe(DE_FRONT);
    expect(String(b.resultat)).toMatch(/plafond/);
  }, 30_000);

  it('appels lancés sans await : leur issue est attendue, pas perdue', async () => {
    const b = await lancer('outil("a.lire"); outil("a.lire"); return "parti"', { jouer: async () => { await new Promise((r) => setTimeout(r, 200)); return ok(1); } });
    expect(b).toMatchObject({ etat: 'termine', resultat: 'parti', appels: { faits: 2, reussis: 2, issue_inconnue: [] } });
  });

  it('un programme à la fois par utilisateur ; le budget se vérifie avant, jamais à mi-course', async () => {
    const p = prendrePlace('u');
    expect(p.ok).toBe(true);
    expect(prendrePlace('u').ok).toBe(false);
    expect(prendrePlace('autre').ok).toBe(true);
    if (p.ok) p.rendre();
    for (let i = 0; i < APPELS_MINUTE_MAX / APPELS_MAX; i++) {
      const q = prendrePlace('u');
      expect(q.ok).toBe(true);
      if (q.ok) q.rendre();
      const b = await lancer(`await Promise.all(Array.from({length:${APPELS_MAX}},()=>outil("a.lire"))); return 1`);
      expect(b.appels.reussis).toBe(APPELS_MAX);
    }
    expect(prendrePlace('u')).toMatchObject({ ok: false });
    expect(prendrePlace('u', Date.now() + 61_000).ok).toBe(true);
  }, 60_000);

  it('429 d\'une app : attendu et refait, le programme n\'échoue pas', async () => {
    let n = 0;
    const b = await lancer('return await outil("a.lire")', { jouer: async () => { if (++n < 3) throw new AppDebit(20); return ok('lu'); } });
    expect(b).toMatchObject({ etat: 'termine', resultat: 'lu', appels: { faits: 1, reussis: 1 } });
  });

  it('résultat trop long : tronqué et dit, la sortie reste sous 16 000 caractères', async () => {
    const t = presenter('p', await lancer('for (let i=0;i<60;i++) journal("x".repeat(400)); sauver("y".repeat(1900)); return "z".repeat(900000)')).content[0].text;
    expect(t.length).toBeLessThan(16_000);
    expect(JSON.parse(t)).toMatchObject({ etat: 'termine', resultat_tronque: true });
  });
});

describe('droits', () => {
  it.each([
    ['lecture seule', { readOnlyHint: true }, false],
    ['non destructif', { readOnlyHint: false, destructiveHint: false }, false],
    ['destructif', { destructiveHint: true }, true],
    ['se dit lecture ET destructif', { readOnlyHint: true, destructiveHint: true }, true],
    ['écriture sans précision', { readOnlyHint: false }, true],
    ['sans annotation', undefined, true],
    ['annotation fantaisiste', { readOnlyHint: 'true' }, true],
  ])('%s', (_n, annotations, attendu) => expect(exigeAutorisation({ annotations })).toBe(attendu));

  it('destructif ou sans annotation : refusé s\'il n\'est pas nommé, l\'app n\'est pas appelée', async () => {
    const jouer = vi.fn(async () => ok(1));
    const code = 'const r=[]; for (const n of ["a.supprimer","a.muet","a.ecrire"]) { try { await outil(n); r.push("joue") } catch (e) { r.push(/autoriser/.test(e.message) ? "refuse" : e.message) } } return r';
    expect((await lancer(code, { jouer })).resultat).toEqual(['refuse', 'refuse', 'joue']);
    expect(jouer).toHaveBeenCalledTimes(1);
    expect((await lancer(code, { jouer, autoriser: new Set(['a.supprimer']) })).resultat).toEqual(['joue', 'refuse', 'joue']);
  });

  it('les outils de la porte, dont executer_programme, ne s\'appellent pas d\'un programme', async () => {
    const b = await lancer('const r=[]; for (const n of ["executer_programme","executer_outil","hub.executer_programme",""]) { try { await outil(n,{code:"1"}); r.push("joue") } catch (e) { r.push("refuse") } } return r', { autoriser: new Set(['executer_programme', 'executer_outil']) });
    expect(b.resultat).toEqual(['refuse', 'refuse', 'refuse', 'refuse']);
  });
});

describe('moteur compromis : rien n\'est cru', () => {
  it('le vol d\'une autorisation ou d\'un nom n\'aboutit pas', async () => {
    const jouer = vi.fn(async () => ok(1));
    const recu: string[] = [];
    await lancer('', { jouer, ouvrirMoteur: menteur([{ t: 'appel', id: 1, nom: 'a.supprimer', args: {}, autorise: true }, { t: 'appel', id: 2, nom: { toString: 'a.lire' }, args: 'x' }, { t: 'fin', ok: true, valeur: 1 }], recu) });
    expect(jouer).not.toHaveBeenCalled();
    expect(recu.filter((l) => l.includes('"ok":false'))).toHaveLength(2);
  });

  it.each([
    ['ligne illisible', ['{pas du json']],
    ['message inconnu', [{ t: 'lire_env' }]],
    ['identifiant rejoué', [{ t: 'appel', id: 1, nom: 'a.lire' }, { t: 'appel', id: 1, nom: 'a.lire' }]],
    ['identifiant absurde', [{ t: 'appel', id: '__proto__', nom: 'a.lire' }]],
    ['null', ['null']],
  ])('%s : programme arrêté', async (_n, lignes) => {
    expect(await lancer('', { ouvrirMoteur: menteur(lignes as never), jouer: () => new Promise(() => {}) })).toMatchObject({ etat: 'erreur' });
  });

  it('ligne sans fin : coupée, la mémoire ne suit pas', async () => {
    const b = await lancer('', { ouvrirMoteur: menteur([], [], (_m, f) => { for (let i = 0; i < 50; i++) f.write('x'.repeat(100_000)); }) });
    expect(b).toMatchObject({ etat: 'erreur', raison: 'moteur_arrete' });
  });

  it('après sa fin, plus aucun appel n\'est joué', async () => {
    const jouer = vi.fn(async () => ok(1));
    await lancer('', { jouer, ouvrirMoteur: menteur([{ t: 'fin', ok: true, valeur: 1 }, { t: 'appel', id: 1, nom: 'a.lire' }]) });
    await new Promise((r) => setTimeout(r, 60));
    expect(jouer).not.toHaveBeenCalled();
  });

  it('flot de messages ou d\'appels énormes : borné', async () => {
    expect(await lancer('', { ouvrirMoteur: menteur(Array.from({ length: 6_000 }, () => ({ t: 'journal', texte: 'x' }))) })).toMatchObject({ raison: 'trop_de_messages' });
    const gros = { t: 'appel', nom: 'a.lire', args: { x: 'y'.repeat(1_500_000) } };
    const recu: string[] = [];
    await lancer('', { ouvrirMoteur: menteur([...Array.from({ length: 14 }, (_, i) => ({ ...gros, id: i + 1 })), { t: 'fin', ok: true }], recu), jouer: async () => { await new Promise((r) => setTimeout(r, 30)); return ok(1); } });
    expect(recu.filter((l) => l.includes('trop de données en attente')).length).toBeGreaterThan(0);
  });

  it('moteur plein, muet ou absent : dit, jamais un faux résultat', async () => {
    expect(await lancer('', { ouvrirMoteur: menteur([{ t: 'occupe' }]) })).toMatchObject({ etat: 'non_lance', raison: 'occupe' });
    expect(await lancer('', { ouvrirMoteur: async () => null })).toMatchObject({ etat: 'non_lance', raison: 'moteur_indisponible' });
    expect(await lancer('', { ouvrirMoteur: menteur([]), delaiMs: 200 })).toMatchObject({ etat: 'interrompu', raison: 'delai' });
  });
});

describe('valeurDe', () => {
  it('donnée structurée, sinon JSON, sinon texte ; une erreur lève', () => {
    expect(valeurDe({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(valeurDe(ok([1]))).toEqual([1]);
    expect(valeurDe({ content: [{ type: 'text', text: 'bonjour' }] })).toBe('bonjour');
    expect(() => valeurDe({ content: [{ type: 'text', text: 'non' }], isError: true })).toThrow('non');
    expect(new AppDebit(1)).toBeInstanceOf(AppInjoignable);
  });

  it('une réponse coupée par l\'app est une erreur, jamais un texte pris pour une donnée', () => {
    const t = (...textes: string[]) => ({ content: textes.map((text) => ({ type: 'text' as const, text })) });
    const entier = JSON.stringify({ lignes: Array.from({ length: 50 }, (_, i) => ({ i })) });
    for (const coupe of [entier.slice(0, 100), `${entier.slice(0, 100)}\n[réponse tronquée à 15000 caractères]`, '[{"a":1},{"a"', '["x","y', '{', ' {\n "a"']) {
      if (coupe === '{') expect(valeurDe(t(coupe))).toBe('{');
      else expect(() => valeurDe(t(coupe)), coupe.slice(0, 20)).toThrow('coupé sa réponse');
    }
    // Du texte qui n'est pas du JSON reste du texte.
    for (const texte of ['[note] rien à dire', '[1] voir la page', '{{nom}} à compléter', '12 contacts', '']) expect(valeurDe(t(texte))).toBe(texte);
    // Un JSON entier suivi d'un commentaire dans un autre bloc : rendu tel quel.
    expect(valeurDe(t('{"a":1}', 'voir la page'))).toBe('{"a":1}\nvoir la page');
    // La donnée structurée prime sur un texte coupé.
    expect(valeurDe({ ...t('{"a":'), structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it('dans un programme : l\'appel coupé lève une exception que le code peut traiter', async () => {
    const b = await lancer('try { await outil("a.lire"); return "donnée" } catch (e) { return String(e.message) }', { jouer: async () => ({ content: [{ type: 'text', text: '{"lignes":[{"a":1},{"b"' }] }) });
    expect(b.resultat).toContain('coupé sa réponse');
    expect(b.appels).toMatchObject({ faits: 1, reussis: 0, echoues: 1 });
  });
});

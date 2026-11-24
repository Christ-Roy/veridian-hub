/**
 * Exécuteur d'un programme (docs/CONTRAT-MCP.md, mode programme). Un processus neuf par programme, dans la prison : sans
 * réseau, sans /proc, sans fichier inscriptible, environnement vide, uid propre. QuickJS n'est que la première barrière ;
 * rien ici n'est cru par le Hub.
 *
 * Entrée, une ligne JSON par message : { t:'programme', code, reprise, delai_ms } puis { t:'reponse', id, ok, valeur|erreur }.
 * Sortie : { t:'appel', id, nom, args } · { t:'etat', valeur } · { t:'journal', texte } · { t:'fin', ok, valeur|erreur }.
 */
import { createInterface } from 'node:readline';

import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import variante from '@jitl/quickjs-wasmfile-release-sync';

const MEMOIRE_OCTETS = 64 * 1024 * 1024;
const PILE_OCTETS = 512 * 1024;
/** Calcul continu sans rendre la main (boucle infinie). Les appels d'outils ne comptent pas. */
const CALCUL_MAX_MS = 10_000;
const JOURNAL_LIGNES = 100;

const ecrire = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const texteErreur = (e) => (e && typeof e === 'object' ? `${e.name ?? 'Erreur'} : ${e.message ?? ''}` : String(e)).slice(0, 2000);

const QuickJS = await newQuickJSWASMModuleFromVariant(variante.default ?? variante);
const runtime = QuickJS.newRuntime();
runtime.setMemoryLimit(MEMOIRE_OCTETS);
runtime.setMaxStackSize(PILE_OCTETS);
const vm = runtime.newContext();

let fini = false;
let numero = 0;
let lignes = 0;
const enAttente = new Map();

function fin(m) {
  if (fini) return;
  fini = true;
  process.stdout.write(`${JSON.stringify({ t: 'fin', ...m })}\n`, () => process.exit(0));
}

/** Fait avancer la machine, jamais plus de CALCUL_MAX_MS d'affilée. */
function avancer(f) {
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + CALCUL_MAX_MS));
  const r = f();
  if (r) return r;
  const jobs = runtime.executePendingJobs();
  if (jobs.error) {
    const e = jobs.error.consume(vm.dump);
    fin({ ok: false, erreur: texteErreur(e) });
  }
  return undefined;
}

function poserJson(json) {
  const s = vm.newString(json);
  const r = vm.callFunction(parse, vm.undefined, s);
  s.dispose();
  return vm.unwrapResult(r);
}
const json = vm.getProp(vm.global, 'JSON');
const parse = vm.getProp(json, 'parse');
const stringify = vm.getProp(json, 'stringify');
function lireJson(h) {
  const r = vm.unwrapResult(vm.callFunction(stringify, vm.undefined, h));
  const t = vm.typeof(r) === 'string' ? vm.getString(r) : null;
  r.dispose();
  return t;
}

const definir = (nom, f) => vm.newFunction(nom, f).consume((h) => vm.setProp(vm.global, nom, h));

definir('outil', (nomH, argsH) => {
  const promesse = vm.newPromise();
  const id = ++numero;
  enAttente.set(id, promesse);
  promesse.settled.then(() => { if (!fini) avancer(() => undefined); });
  const args = argsH && vm.typeof(argsH) === 'object' ? lireJson(argsH) : '{}';
  ecrire({ t: 'appel', id, nom: vm.typeof(nomH) === 'string' ? vm.getString(nomH) : '', args: JSON.parse(args ?? '{}') });
  return promesse.handle;
});
definir('sauver', (h) => { const t = h ? lireJson(h) : null; if (t !== null) ecrire({ t: 'etat', valeur: JSON.parse(t) }); });
definir('journal', (...hs) => {
  if (++lignes > JOURNAL_LIGNES) return;
  ecrire({ t: 'journal', texte: hs.map((h) => (vm.typeof(h) === 'string' ? vm.getString(h) : lireJson(h) ?? '')).join(' ').slice(0, 500) });
});
definir('pause', (msH) => {
  const promesse = vm.newPromise();
  const ms = Math.max(0, Math.min(30_000, Number(msH ? vm.dump(msH) : 0) || 0));
  promesse.settled.then(() => { if (!fini) avancer(() => undefined); });
  setTimeout(() => { if (!fini) { promesse.resolve(vm.undefined); } }, ms);
  return promesse.handle;
});

function demarrer({ code, reprise }) {
  poserJson(JSON.stringify(reprise ?? null)).consume((h) => vm.setProp(vm.global, 'reprise', h));
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + CALCUL_MAX_MS));
  const r = vm.evalCode(`(async () => {\n${code}\n})()`, 'programme.js');
  if (r.error) return fin({ ok: false, erreur: texteErreur(r.error.consume(vm.dump)) });
  const issue = vm.resolvePromise(r.value);
  r.value.dispose();
  issue.then((x) => {
    if (x.error) return fin({ ok: false, erreur: texteErreur(x.error.consume(vm.dump)) });
    const t = lireJson(x.value);
    x.value.dispose();
    fin({ ok: true, valeur: t === null ? null : JSON.parse(t) });
  }).catch((e) => fin({ ok: false, erreur: texteErreur(e) }));
  avancer(() => undefined);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (ligne) => {
  try {
    const m = JSON.parse(ligne);
    if (m.t === 'programme') demarrer(m);
    else if (m.t === 'reponse') {
      const p = enAttente.get(m.id);
      if (!p || fini) return;
      enAttente.delete(m.id);
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + CALCUL_MAX_MS));
      if (m.ok) poserJson(JSON.stringify(m.valeur ?? null)).consume((h) => p.resolve(h));
      else vm.newError(String(m.erreur ?? 'erreur')).consume((h) => p.reject(h));
    }
  } catch (e) {
    fin({ ok: false, erreur: texteErreur(e) });
  }
}).on('close', () => process.exit(0));
process.on('uncaughtException', (e) => fin({ ok: false, erreur: texteErreur(e) }));
process.on('unhandledRejection', (e) => fin({ ok: false, erreur: texteErreur(e) }));

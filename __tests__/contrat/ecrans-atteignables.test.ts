/**
 * Contrat : tout écran de app/dashboard est visé par un lien, un push ou une redirection du code
 * (app, components, lib), hors sa propre page. Un écran sans lien existe mais personne ne le trouve
 * (VER-263 : sécurité, compte d'envoi mail).
 */
import { describe, expect, it } from 'vitest';

import { code, parcourir } from './source';

/** Écrans volontairement sans lien. Chaque entrée dit pourquoi ; une entrée devenue inutile fait échouer le test. */
const EXCEPTIONS: Record<string, string> = {
  // VER-263, session Hub B : /dashboard/admin/** lui appartient, le lien vient avec son lot.
  '/dashboard/admin/lookup': 'session Hub B',
};

const sources = ['app', 'components', 'lib'].flatMap(parcourir).filter((p) => /\.(ts|tsx)$/.test(p));

const ecrans = parcourir('app/dashboard')
  .filter((p) => p.endsWith('/page.tsx'))
  .map((p) => ({
    fichier: p,
    route: '/' + p.replace(/\/page\.tsx$/, '').replace(/^app\//, ''),
  }));

const motif = (route: string) =>
  new RegExp('^' + route.split('/').map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&'))).join('/') + '/?$');

const vises = new Map<string, string[]>();
for (const f of sources) {
  const chemins = [...code(f).matchAll(/(['"`])(\/dashboard(?:[^'"`\n]*?))\1/g)].map((m) => m[2].replace(/\$\{[^}]*\}/g, 'x').split(/[?#]/)[0]);
  if (chemins.length) vises.set(f, chemins);
}

const cheminsVises = (sauf: string) => [...vises].filter(([f]) => f !== sauf).flatMap(([, c]) => c);

const viseParAilleurs = (e: { fichier: string; route: string }) => {
  const re = motif(e.route);
  return cheminsVises(e.fichier).some((c) => re.test(c));
};

describe('écrans du tableau de bord atteignables', () => {
  it('le parcours trouve des écrans', () => {
    expect(ecrans.length).toBeGreaterThan(8);
  });

  it.each(ecrans.filter((e) => !(e.route in EXCEPTIONS)).map((e) => [e.route, e] as const))('%s est visé par un lien', (_route, e) => {
    expect(viseParAilleurs(e), `aucun href, push ou redirect ne mène à ${e.route}`).toBe(true);
  });

  it.each(Object.keys(EXCEPTIONS))('exception %s encore nécessaire', (route) => {
    const e = ecrans.find((x) => x.route === route);
    expect(e, `${route} n'existe plus : retirer l'exception`).toBeDefined();
    expect(viseParAilleurs(e!), `${route} est maintenant visé : retirer l'exception`).toBe(false);
  });
});

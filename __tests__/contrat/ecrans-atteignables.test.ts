/**
 * Contrat : tout écran de app/dashboard est visé par un autre écran (.tsx, menu compris). Un écran sans lien existe mais personne ne le trouve
 * (VER-263 : sécurité, compte d'envoi mail).
 */
import { describe, expect, it } from 'vitest';

import { code, parcourir } from './source';

/** Écrans volontairement sans lien. Chaque entrée dit pourquoi ; une entrée devenue inutile fait échouer le test. */
const EXCEPTIONS: Record<string, string> = {
  // Mail y envoie la personne (docs/CONTRAT-MAIL.md) ; pas proposé d'ici tant que l'accord de Google n'a pas été joué en vrai.
  '/dashboard/settings/mail': 'entrée depuis Mail',
  // Connexions extérieures fermées (VER-119) : l'entrée du menu vient avec leur ouverture, session Hub C.
  '/dashboard/connexions': 'session Hub C',
};

// Ce qu'une personne peut cliquer : les écrans et leurs morceaux. La redirection d'une route d'API ne rend pas un écran trouvable.
const sources = ['app', 'components', 'lib'].flatMap(parcourir).filter((p) => p.endsWith('.tsx') || /^(lib|components)\/.*nav.*\.ts$/.test(p));

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
    expect(viseParAilleurs(e), `aucun écran ne mène à ${e.route}`).toBe(true);
  });

  it.each(Object.keys(EXCEPTIONS))('exception %s encore nécessaire', (route) => {
    const e = ecrans.find((x) => x.route === route);
    expect(e, `${route} n'existe plus : retirer l'exception`).toBeDefined();
    expect(viseParAilleurs(e!), `${route} est maintenant visé : retirer l'exception`).toBe(false);
  });
});

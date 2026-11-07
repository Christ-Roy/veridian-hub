/**
 * Contrat : le rebond (prepare puis complete) ne redirige que vers
 *  - une page du Hub (`new URL('/…', baseUrl)`),
 *  - l'URL demandée `parsed.url`, déjà filtrée par `parseNext` ET par la liste des apps déclarées,
 *  - le lien rendu par l'app (`magicLinkUrl`), dont l'hôte est revérifié dans bounce-apps.
 * Toute autre cible (un paramètre brut, un en-tête, un cookie non vérifié) fait échouer ce test.
 *
 * Comportements (hors liste, anti-boucle) : __tests__/api/auth/bounce/prepare.test.ts et complete.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { listSupportedApps } from '@/lib/auth/bounce-apps';
import { parseNext } from '@/lib/auth/bounce-next';

import { code } from './source';

const ROUTES = ['app/api/auth/bounce/prepare/route.ts', 'app/api/auth/bounce/complete/route.ts'];

/** Argument de chaque `NextResponse.redirect(…)`, parenthèses équilibrées. */
function cibles(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/NextResponse\.redirect\(/g)) {
    let i = (m.index ?? 0) + m[0].length;
    const debut = i;
    let prof = 1;
    while (i < src.length && prof > 0) {
      if (src[i] === '(') prof++;
      else if (src[i] === ')') prof--;
      i++;
    }
    out.push(src.slice(debut, i - 1).replace(/\s+/g, ' ').trim());
  }
  return out;
}

const AUTORISEES = [
  /^new URL\('\/[a-z/]*', baseUrl\)$/, // page du Hub
  /^(loginUrl|stop|url)$/, // URL construites sur le Hub, vérifiées ci-dessous
  /^parsed\.url$/, // cible filtrée
  /^magicLinkUrl$/, // lien de l'app, hôte revérifié
];

describe('outil : cibles() voit les redirections', () => {
  it('extrait l\'argument avec ses parenthèses imbriquées', () => {
    expect(cibles("a(NextResponse.redirect(new URL('/x', b)))")).toEqual(["new URL('/x', b)"]);
  });
});

describe('redirections du rebond', () => {
  it.each(ROUTES)('%s : chaque redirect vise une cible autorisée', (route) => {
    const toutes = cibles(code(route));
    expect(toutes.length).toBeGreaterThan(0);
    for (const c of toutes) expect(AUTORISEES.some((re) => re.test(c)), c).toBe(true);
  });

  it.each(ROUTES)('%s : les URL intermédiaires sont bâties sur la base du Hub', (route) => {
    const src = code(route);
    for (const m of src.matchAll(/const (loginUrl|stop|url) = new URL\(([^;]+)\);/g)) {
      // `new URL(req.url)` est la lecture de la requête entrante, pas une cible.
      if (m[2].trim() !== 'req.url') expect(m[2], m[0]).toMatch(/baseUrl\s*$/);
    }
  });

  it('complete ne redirige vers le lien de l\'app qu\'après avoir contrôlé l\'adresse prouvée', () => {
    const src = code('app/api/auth/bounce/complete/route.ts');
    expect(src.indexOf('denyUnlessEmailProven(user)')).toBeGreaterThan(0);
    expect(src.indexOf('denyUnlessEmailProven(user)')).toBeLessThan(src.indexOf('issueMagicLinkForApp('));
  });

  it('le lien rendu par l\'app est refusé hors *.veridian.site en https', () => {
    const src = code('lib/auth/bounce-apps.ts');
    expect(src).toMatch(/if \(!isVeridianHost\(magicLinkUrl\)\)\s*\{\s*throw new BounceError/);
    expect(src).toMatch(/protocol !== 'https:'/);
  });
});

describe('seules les apps déclarées sont des cibles', () => {
  it('la liste est celle attendue (une app ajoutée sans test de rebond le dit ici)', () => {
    expect(listSupportedApps().sort()).toEqual([
      'analytics',
      'analytics-rybbit',
      'cms',
      'crm',
      'notifuse',
      'prospection',
    ]);
  });

  it('prepare filtre le résultat de parseNext par cette liste', () => {
    const src = code('app/api/auth/bounce/prepare/route.ts');
    expect(src).toMatch(/listSupportedApps\(\)\.includes\(candidate\.app\)/);
  });

  it('un site client sous veridian.site passe le motif de parseNext : seul le filtre par app le retient', () => {
    const c = parseNext('https://boutique-dupont.veridian.site/', 'production');
    // Ce que prepare reçoit de parseNext : l'app n'est pas dans la liste, donc pas une cible.
    expect(c === null || !listSupportedApps().includes(c.app)).toBe(true);
  });

  it.each(listSupportedApps())('%s : son hôte réel est accepté, un hôte d\'imitation refusé', (app) => {
    const hote = app === 'crm' ? 'espace.crm.app' : `${app}.app`;
    expect(parseNext(`https://${hote}.veridian.site/x`, 'production')?.app).toBe(app);
    expect(parseNext(`https://${hote}.veridian.site.evil.com/x`, 'production')).toBeNull();
    expect(parseNext(`https://${app}.app.evil.com/x`, 'production')).toBeNull();
  });
});

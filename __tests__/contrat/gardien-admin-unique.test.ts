/**
 * Contrat : AUCUNE route `app/api/admin/**` n'échappe au gardien unique (`authenticateAdmin`).
 * Le scan lit le code source (commentaires retirés) de chaque `route.ts`. Un contrôle positif (une route connue gardée) prouve la méthode ;
 * le sabotage (retirer la garde d'une route) a été vu échouer avant d'être cru.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { sansCommentaires } from './source';

const RACINE = join(__dirname, '..', '..');
const DOSSIER_ADMIN = join(RACINE, 'app', 'api', 'admin');

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((nom) => {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) return routes(chemin);
    return nom === 'route.ts' ? [chemin] : [];
  });
}

const relatif = (f: string) => relative(RACINE, f).split(sep).join('/');
const code = (f: string) => sansCommentaires(readFileSync(f, 'utf8'));

/**
 * Routes sous `app/api/admin` qui NE passent PAS par le gardien, avec la raison. Liste fermée : toute nouvelle entrée se justifie ici.
 * `notifuse/magic-link` : lien d'ouverture de Mail pour le PROPRIÉTAIRE de l'espace (ou un administrateur), pas une route d'administration.
 * Sa garde est dans le corps : `denyUnlessEmailProven` puis propriétaire ou `sessionAdmin`.
 */
const HORS_GARDIEN: Record<string, string> = {
  'app/api/admin/notifuse/magic-link/route.ts': 'route propriétaire (propriétaire de l\'espace ou administrateur), garde dans le corps',
};

/**
 * Routes qui passent par le shim `requireAdmin` (lib/admin/require-admin.ts), qui délègue à `authenticateAdmin`.
 * Une seule : `connecteurs`, fichier d'une autre session à migrer. Tout ajout ici est un défaut.
 */
const PAR_LE_SHIM: Record<string, string> = {
  'app/api/admin/connecteurs/route.ts': 'à migrer vers authenticateAdmin (fichier hors chantier)',
};

const toutes = routes(DOSSIER_ADMIN).map((f) => ({ rel: relatif(f), src: code(f) }));

describe('gardien admin unique : scan de app/api/admin/**', () => {
  it('contrôle positif : le scan trouve les routes admin (pas une liste vide)', () => {
    expect(toutes.length).toBeGreaterThanOrEqual(45);
    const grant = toutes.find((r) => r.rel === 'app/api/admin/grant-plan/route.ts');
    expect(grant).toBeDefined();
    expect(grant!.src).toMatch(/await authenticateAdmin\(/);
  });

  it('chaque route passe par authenticateAdmin, ou figure dans la liste fermée', () => {
    const fautives: string[] = [];
    for (const { rel, src } of toutes) {
      if (HORS_GARDIEN[rel]) continue;
      if (PAR_LE_SHIM[rel]) {
        if (!/await requireAdmin\(/.test(src)) fautives.push(`${rel} (shim attendu, absent)`);
        continue;
      }
      if (!/await authenticateAdmin\(/.test(src)) fautives.push(rel);
    }
    expect(fautives).toEqual([]);
  });

  it('chaque appel de garde est suivi d\'un refus réel (ok ou response, jamais un objet toujours vrai)', () => {
    const fautives: string[] = [];
    for (const { rel, src } of toutes) {
      if (!/await authenticateAdmin\(/.test(src)) continue;
      // Un appel doit être testé par `.ok` (ou `garde.response`) ; `if (refus)` sur un objet est toujours vrai.
      if (/const (\w+) = await authenticateAdmin\([^)]*\);\s*\n\s*if \(\1\)/.test(src)) fautives.push(rel);
    }
    expect(fautives).toEqual([]);
  });

  it('aucune route admin ne compare la clé ni ne lit la session à part : pas de second gardien', () => {
    const fautives: string[] = [];
    for (const { rel, src } of toutes) {
      if (HORS_GARDIEN[rel]) continue;
      if (/secretAdminValide\(|headers\.get\(['"]x-admin-secret['"]\)|sessionAdmin\(\)/.test(src)) fautives.push(rel);
    }
    expect(fautives).toEqual([]);
  });

  it('la liste d\'exceptions est exacte : chaque exception existe et reste hors du gardien', () => {
    for (const rel of [...Object.keys(HORS_GARDIEN), ...Object.keys(PAR_LE_SHIM)]) {
      expect(toutes.map((r) => r.rel)).toContain(rel);
    }
    const magic = toutes.find((r) => r.rel === 'app/api/admin/notifuse/magic-link/route.ts')!;
    expect(magic.src).not.toMatch(/authenticateAdmin\(/);
  });
});

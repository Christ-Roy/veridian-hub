/**
 * Outils des tests de contrat : lecture du code source sans ses commentaires, pour que les gardes
 * statiques portent sur le code et pas sur l'explication qui en parle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Retire commentaires de ligne et de bloc. Les chaînes sont conservées (une chaîne 'iat' compte). */
export function sansCommentaires(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += d ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

export function lire(chemin: string): string {
  return readFileSync(chemin, 'utf8');
}

export function code(chemin: string): string {
  return sansCommentaires(lire(chemin));
}

export function parcourir(dir: string): string[] {
  return readdirSync(dir).flatMap((nom) => {
    if (nom === 'node_modules' || nom.startsWith('.')) return [];
    const p = join(dir, nom);
    return statSync(p).isDirectory() ? parcourir(p) : [p];
  });
}

/** Tous les .ts/.tsx du code applicatif qui peut créer ou lire une session. */
export function sourcesApplicatives(): string[] {
  return [
    ...parcourir('app'),
    ...parcourir('lib'),
    'auth.ts',
    'auth.config.ts',
    'middleware.ts',
  ].filter((p) => /\.(ts|tsx)$/.test(p));
}

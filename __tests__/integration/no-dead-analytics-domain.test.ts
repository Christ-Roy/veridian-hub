/**
 * Test invariant CI — le domaine Analytics MORT ne doit jamais revenir en dur
 * dans le code applicatif.
 *
 * CONTEXTE : `analytics.app.veridian.site` servait l'app Analytics historique
 * (Next.js/Prisma). Elle est **décommissionnée** — le domaine répond HTTP 404
 * (vérifié en live le 2026-07-28). L'app vivante est le fork staminads servi
 * sur `analytics-engine.app.veridian.site` (HTTP 200).
 *
 * Le Hub avait gardé l'ancien domaine à deux endroits qui touchaient
 * directement le client final :
 *   - la card « Veridian Analytics » du dashboard (bouton « Ouvrir » → 404)
 *   - le fallback générique `<app>.app.veridian.site` de
 *     `resolveDownstreamBaseUrl`, utilisé par les invitations cross-app
 *
 * Ce test empêche la régression : le fallback correct vit désormais dans
 * `DEFAULT_APP_BASE_URL` (`lib/invitations/attach-downstream.ts`), et personne
 * ne doit re-coller l'ancien domaine ailleurs.
 *
 * Cf. `todo/2026-07-28-autologin-analytics-contrat-et-etat-reel.md`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Domaine décommissionné, hors préfixe `analytics-engine.`. */
const DEAD_DOMAIN = /(?<!-engine)\banalytics\.app\.veridian\.site/;

/** Dossiers applicatifs scannés — le code qui tourne réellement. */
const SCANNED_DIRS = ['app', 'lib', 'components'];

/**
 * Exceptions légitimes :
 *  - `lib/mail/oauth-cookies.ts` : liste d'origines HISTORIQUES autorisées pour
 *    le retour OAuth. Retirer un domaine de cette allow-list casserait le
 *    retour des sessions encore en vol — c'est une liste d'accueil, pas une
 *    cible d'appel.
 *  - les commentaires qui documentent précisément que ce domaine est mort.
 */
const ALLOWED_FILES = new Set(['lib/mail/oauth-cookies.ts']);

function collectFiles(dir: string): string[] {
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('Invariant CI — domaine Analytics décommissionné', () => {
  it('aucun fichier applicatif ne cible analytics.app.veridian.site', () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of collectFiles(dir)) {
        if (ALLOWED_FILES.has(file)) continue;
        const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');

        content.split('\n').forEach((line, i) => {
          if (!DEAD_DOMAIN.test(line)) return;
          // Une ligne de commentaire qui documente que le domaine est mort
          // est légitime — c'est ce qui explique le choix au lecteur suivant.
          const trimmed = line.trim();
          const isComment =
            trimmed.startsWith('*') ||
            trimmed.startsWith('//') ||
            trimmed.startsWith('/*');
          if (isComment) return;
          offenders.push(`${file}:${i + 1}`);
        });
      }
    }

    expect(
      offenders,
      `Ces lignes ciblent le domaine Analytics MORT (404) au lieu de ` +
        `analytics-engine.app.veridian.site — utiliser resolveDownstreamBaseUrl('analytics') :\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it("le fallback du résolveur pointe sur l'engine vivant", async () => {
    const { resolveDownstreamBaseUrl } = await import(
      '@/lib/invitations/attach-downstream'
    );
    expect(resolveDownstreamBaseUrl('analytics', {} as NodeJS.ProcessEnv)).toBe(
      'https://analytics-engine.app.veridian.site',
    );
  });
});

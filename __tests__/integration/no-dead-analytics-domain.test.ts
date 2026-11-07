/**
 * Invariant CI — le domaine Analytics servi AU CLIENT suit la génération
 * courante, et personne ne le recolle en dur.
 *
 * POURQUOI CE TEST A CHANGÉ DE SENS (à lire avant de le « corriger »)
 * ------------------------------------------------------------------
 * Écrit le 2026-07-28, il interdisait `analytics.app.veridian.site` : ce
 * domaine servait alors la première génération, décommissionnée, et répondait
 * 404. L'app vivante était le fork staminads sur `analytics-engine.*`.
 *
 * Depuis le 2026-08-18, `analytics.app.veridian.site` sert la NOUVELLE
 * génération (fork Rybbit rebrandé Veridian), qui est la cible produit. Le
 * garde-fou s'était donc retourné contre nous : il faisait échouer la bonne
 * configuration.
 *
 * L'invariant durable n'est pas « tel domaine est interdit » — il aurait
 * fallu le réécrire à chaque génération. C'est : **le code qui envoie un
 * client vers l'analytics ne code aucun domaine en dur, il passe par le
 * résolveur.** Ainsi une prochaine bascule est une variable d'environnement,
 * pas une chasse aux chaînes de caractères.
 *
 * `analytics-engine.app.veridian.site` n'est PAS mort : la génération
 * précédente tourne toujours et sert encore des clients. Les usages internes
 * qui la visent volontairement sont listés en exception ci-dessous.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** N'importe quel domaine d'analytics écrit en dur. */
const HARDCODED_ANALYTICS_DOMAIN = /\banalytics(-engine)?\.app\.veridian\.site/;

/** Dossiers applicatifs scannés — le code qui tourne réellement. */
const SCANNED_DIRS = ['app', 'lib', 'components'];

/**
 * Exceptions légitimes, chacune pour une raison différente :
 *
 *  - `lib/invitations/attach-downstream.ts` : c'est LE résolveur. Les défauts
 *    doivent bien s'écrire quelque part, et c'est ici.
 *  - `lib/mail/oauth-cookies.ts` : allow-list d'origines HISTORIQUES pour le
 *    retour OAuth. Retirer un domaine casserait les sessions encore en vol —
 *    c'est une liste d'accueil, pas une cible d'appel.
 *  - `lib/analytics/track-event.ts` : le Hub mesure son PROPRE usage sur la
 *    génération précédente. Cible interne, pas un lien servi à un client.
 *  - `lib/prospect/engine-client.ts` : pull des events prospect depuis la
 *    génération précédente, où vit l'historique. Idem, interne.
 *
 * Les deux dernières disparaîtront quand ces flux auront migré ; tant qu'elles
 * sont là, elles sont volontaires et documentées.
 */
const ALLOWED_FILES = new Set([
  'lib/invitations/attach-downstream.ts',
  'lib/mail/oauth-cookies.ts',
  'lib/analytics/track-event.ts',
  'lib/prospect/engine-client.ts',
]);

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

describe('Invariant CI — domaine Analytics servi au client', () => {
  it('aucun fichier applicatif ne code un domaine Analytics en dur', () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of collectFiles(dir)) {
        if (ALLOWED_FILES.has(file)) continue;
        const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');

        content.split('\n').forEach((line, i) => {
          if (!HARDCODED_ANALYTICS_DOMAIN.test(line)) return;
          // Un commentaire qui documente l'historique est légitime — c'est ce
          // qui évite au lecteur suivant de refaire l'erreur.
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
      `Ces lignes codent un domaine Analytics en dur au lieu de passer par ` +
        `resolveDownstreamBaseUrl('analytics') ou resolveAnalyticsCardTarget() :\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('le défaut du résolveur pointe sur la génération courante', async () => {
    const { resolveDownstreamBaseUrl } = await import(
      '@/lib/invitations/attach-downstream'
    );
    expect(resolveDownstreamBaseUrl('analytics', {} as NodeJS.ProcessEnv)).toBe(
      'https://analytics.app.veridian.site',
    );
  });

  it("la variable d'environnement prime sur le défaut", async () => {
    const { resolveDownstreamBaseUrl } = await import(
      '@/lib/invitations/attach-downstream'
    );
    expect(
      resolveDownstreamBaseUrl('analytics', {
        NEXT_PUBLIC_ANALYTICS_URL: 'https://analytics-engine.app.veridian.site/',
      } as NodeJS.ProcessEnv),
    ).toBe('https://analytics-engine.app.veridian.site');
  });
});

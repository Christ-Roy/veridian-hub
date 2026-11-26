/**
 * Recette de A à Z (cas 50) : une seule organisation jetable traverse tout le parcours d'un client, étape par étape. Chaque étape rend VRAI, FAUX
 * ou NON ABOUTI, laisse sa capture réelle, et la recette CONTINUE après un faux : le tableau dit tout ce qui a été mesuré, pas seulement le premier
 * défaut. Sortie : `.run/recette/tableau.md` et `.run/recette/NN-<étape>.png`. Aucune adresse dans le tableau (dépôt public, `masquer`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { masquer } from './cibles';
import { NonAbouti } from './etat';
import type { Compte } from './parcours';
import { RUN_DIR } from './versions';

export const DOSSIER_RECETTE = join(RUN_DIR, 'recette');

export type EtatEtape = 'VRAI' | 'FAUX' | 'NON_ABOUTI';
export type Ligne = { n: number; etape: string; etat: EtatEtape; detail: string; captures: string[]; secondes: number };

/** Ce que chaque étape reçoit : l'organisation jetable et ses personnes, et de quoi laisser une capture. */
export type Recette = {
  browser: Browser;
  /** Propriétaire de l'organisation jetable (adresse e2e-sso-…@veridian.site, prouvée). */
  P: Compte;
  /** Organisation Hub (tenant) jetable, marquée de test. */
  tenantId: string;
  /** Membre invité dans l'organisation, posé par l'étape d'invitation ; absent avant. */
  M?: Compte;
  /** Valeurs que les étapes se passent (espace CRM, slug Mail, identifiants d'app…). Jamais d'adresse ni de secret. */
  notes: Record<string, string>;
  /** Capture pleine page, rangée sous le numéro de l'étape en cours. Rend le chemin. */
  capture: (page: Page, nom: string) => Promise<string>;
  /** Contexte navigateur ouvert avec la session Hub d'une personne. À fermer par l'appelant. */
  contexte: (c: Compte) => Promise<BrowserContext>;
};

export function creerRecette(browser: Browser, P: Compte, tenantId: string): { r: Recette; etape: (nom: string, corps: (r: Recette) => Promise<string>) => Promise<EtatEtape>; tableau: () => Ligne[]; ecrire: () => string } {
  mkdirSync(DOSSIER_RECETTE, { recursive: true });
  const lignes: Ligne[] = [];
  let courante: Ligne | null = null;
  const r: Recette = {
    browser,
    P,
    tenantId,
    notes: {},
    capture: async (page, nom) => {
      const n = courante?.n ?? 0;
      const fichier = join(DOSSIER_RECETTE, `${String(n).padStart(2, '0')}-${nom.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.png`);
      await page.screenshot({ path: fichier, fullPage: true }).catch(() => undefined);
      courante?.captures.push(fichier);
      return fichier;
    },
    contexte: (c) => {
      if (!c.etat) throw new NonAbouti(`${c.etiquette} : aucune session Hub enregistrée`);
      return browser.newContext({ storageState: c.etat as never });
    },
  };
  const etape = async (nom: string, corps: (r: Recette) => Promise<string>): Promise<EtatEtape> => {
    const l: Ligne = { n: lignes.length + 1, etape: nom, etat: 'NON_ABOUTI', detail: '', captures: [], secondes: 0 };
    lignes.push(l);
    courante = l;
    const t0 = Date.now();
    try {
      l.detail = (await corps(r)) || 'fait';
      l.etat = 'VRAI';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      l.etat = e instanceof NonAbouti ? 'NON_ABOUTI' : 'FAUX';
      l.detail = msg.split('\n').filter(Boolean).slice(0, 4).join(' ⏎ ');
    }
    l.secondes = Math.round((Date.now() - t0) / 1000);
    l.detail = masquer(l.detail).slice(0, 500);
    console.log(`[recette] ${l.n}. ${nom} : ${l.etat} (${l.secondes} s) ${l.detail.slice(0, 200)}`);
    courante = null;
    ecrire();
    return l.etat;
  };
  const ecrire = () => {
    const icone = { VRAI: '✅ vrai', FAUX: '❌ faux', NON_ABOUTI: '⚠️ non abouti' } as const;
    const somme = (e: EtatEtape) => lignes.filter((l) => l.etat === e).length;
    const texte = [
      `# Recette A à Z, ${new Date().toISOString()}`,
      '',
      `${somme('VRAI')} vrai · ${somme('FAUX')} faux · ${somme('NON_ABOUTI')} non abouti, sur ${lignes.length} étapes. Organisation jetable ${tenantId}.`,
      '',
      '| # | Étape | État | Détail | Captures | s |',
      '|---|---|---|---|---|---|',
      ...lignes.map((l) => `| ${l.n} | ${l.etape} | ${icone[l.etat]} | ${l.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} | ${l.captures.map((c) => c.split('/').pop()).join(', ')} | ${l.secondes} |`),
      '',
    ].join('\n');
    writeFileSync(join(DOSSIER_RECETTE, 'tableau.md'), texte);
    return texte;
  };
  return { r, etape, tableau: () => lignes, ecrire };
}

/** Une étape qui exige une valeur posée par une étape précédente : NON ABOUTI si elle manque (l'étape d'avant a échoué). */
export function exiger(r: Recette, cle: string): string {
  const v = r.notes[cle];
  if (!v) throw new NonAbouti(`« ${cle} » manque : l'étape qui le pose n'a pas abouti`);
  return v;
}

/**
 * État partagé de la run : les comptes de test et ce qu'on a déjà mesuré. Persisté sur
 * disque, car un cas qui ÉCHOUE fait redémarrer le worker Playwright et on ne doit pas
 * recréer (ni orpheliner) des comptes à chaque échec.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Browser } from '@playwright/test';

import type { AppKey } from './cibles';
import { NonAbouti } from './etat';
import { rybbitCompte } from './hub-admin';
import { type Atterrissage, type Compte, creerCompteNonProuve, creerCompteProuve, ID_RUN, ouvrirApp } from './parcours';
import { RUN_DIR } from './versions';
import type { BrowserContext } from '@playwright/test';

const FICHIER = path.join(RUN_DIR, `monde-${ID_RUN}.json`);

type Monde = {
  comptes: Record<string, Compte>;
  arrivees: Record<string, { ok: boolean; atterrissage: Atterrissage }>;
  reconcileBase?: any;
  rybbit: string[];
};

function lire(): Monde {
  if (existsSync(FICHIER)) return JSON.parse(readFileSync(FICHIER, 'utf8'));
  return { comptes: {}, arrivees: {}, rybbit: [] };
}
function ecrire(m: Monde) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(FICHIER, JSON.stringify(m));
}

export async function compte(browser: Browser, etiquette: 'A' | 'B' | 'NP'): Promise<Compte> {
  const m = lire();
  if (m.comptes[etiquette]) return m.comptes[etiquette];
  let c: Compte;
  try {
    c = etiquette === 'NP' ? await creerCompteNonProuve(browser, 'np') : await creerCompteProuve(browser, etiquette.toLowerCase());
  } catch (e) {
    // Un compte qu'on ne parvient pas à créer n'est pas un défaut de l'app testée : on n'a rien mesuré.
    if (e instanceof NonAbouti) throw e;
    throw new NonAbouti(`création du compte de test ${etiquette} impossible : ${(e as Error).message.split('\n')[0]}`);
  }
  const m2 = lire();
  m2.comptes[etiquette] = c;
  ecrire(m2);
  return c;
}

export function comptesCrees(): Compte[] {
  return Object.values(lire().comptes);
}

export function memoArrivee(app: AppKey) {
  return lire().arrivees[app] ?? null;
}
export function noterArrivee(app: AppKey, ok: boolean, atterrissage: Atterrissage) {
  const m = lire();
  m.arrivees[app] = { ok, atterrissage };
  ecrire(m);
}

/** Crée (une fois) le compte Rybbit du compte de test : sans lui, le rebond répond user_not_in_app. */
export function assurerRybbit(c: Compte) {
  const m = lire();
  if ((m.rybbit ?? []).includes(c.email)) return;
  m.rybbit = [...(m.rybbit ?? []), c.email];
  ecrire(m); // noté AVANT la création : un crash ne doit pas orpheliner le compte
  rybbitCompte('creer', c.email);
}
export function comptesRybbit(): string[] {
  return lire().rybbit ?? [];
}

export function reconcileBase() {
  return lire().reconcileBase ?? null;
}
export function noterReconcileBase(r: any) {
  const m = lire();
  m.reconcileBase = r;
  ecrire(m);
}

/** Contexte navigateur portant la session Hub ouverte du compte. */
export async function contexteDe(browser: Browser, c: Compte): Promise<BrowserContext> {
  if (!c.etat) throw new Error('ce compte n\'a pas de session Hub ouverte');
  return browser.newContext({ storageState: c.etat });
}

export { ouvrirApp };

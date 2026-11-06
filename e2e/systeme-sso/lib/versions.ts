/**
 * Version SERVIE de chaque app, relue (jamais supposée) :
 *  1. `.run/versions.json` écrit par le lanceur (image Nomad, lue sur le bastion) ;
 *  2. sinon `nomad job inspect` directement si la CLI répond ;
 *  3. sinon `SSO_VERSIONS` (JSON {"hub":"v0.5.42",...}) ;
 *  4. sinon non lue, et la batterie traite l'app comme corrigée (rigueur max :
 *     pas d'« attendu rouge » sans version relue).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SERVI } from './cibles';

export const RUN_DIR = path.join(__dirname, '..', '.run');
const FICHIER = path.join(RUN_DIR, 'versions.json');

export type Versions = Record<string, { lu: string | null; source: string }>;
let memo: Versions | null = null;

function imageNomad(job: string): string | null {
  try {
    const out = execFileSync('nomad', ['job', 'inspect', '-json', job], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const images = Array.from(out.matchAll(/"[Ii]mage": *"([^"]+)"/g))
      .map((m) => m[1])
      .filter((i) => !/postgres|clickhouse|redis|pgbackrest/.test(i));
    return images.length ? Array.from(new Set(images)).join(' + ') : null;
  } catch {
    return null;
  }
}

export async function versionsServies(): Promise<Versions> {
  if (memo) return memo;
  if (existsSync(FICHIER)) {
    memo = JSON.parse(readFileSync(FICHIER, 'utf8')) as Versions;
    return memo;
  }
  const v: Versions = {};
  const env = process.env.SSO_VERSIONS ? JSON.parse(process.env.SSO_VERSIONS) : {};
  for (const [cle, def] of Object.entries(SERVI)) {
    const nomad = def.job ? imageNomad(def.job) : null;
    if (nomad) v[cle] = { lu: nomad, source: 'nomad job inspect' };
    else if (env[cle]) v[cle] = { lu: String(env[cle]), source: 'SSO_VERSIONS' };
    else v[cle] = { lu: null, source: 'non lue' };
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(FICHIER, JSON.stringify(v, null, 2));
  memo = v;
  return v;
}

/** Vrai si la version lue porte un des marqueurs de correctif (ou si elle n'a pas été lue). */
export function estCorrige(cle: keyof typeof SERVI, v: Versions): boolean {
  const lu = v[cle]?.lu;
  if (!lu) return true;
  const force = (process.env.SSO_APPS_CORRIGEES || '').split(',').map((s) => s.trim());
  if (force.includes(cle)) return true;
  if (cle === 'hub') {
    // Hub versionné en semver : toute version >= au correctif compte.
    const m = lu.match(/veridian-hub:v(\d+)\.(\d+)\.(\d+)/);
    const min = SERVI.hub.corrige[0].match(/v(\d+)\.(\d+)\.(\d+)/);
    if (m && min) {
      const a = m.slice(1).map(Number);
      const b = min.slice(1).map(Number);
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return true;
    }
  }
  return SERVI[cle].corrige.some((m) => lu.includes(m));
}

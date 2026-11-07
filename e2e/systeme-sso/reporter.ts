/**
 * Reporter à trois états (plus « attendu rouge »). Écrit `.run/resultat.json` et `.run/resultat.txt`.
 * Le code de sortie est calculé par le lanceur : 1 si un ECHOUE, sinon 2 si un NON_ABOUTI, sinon 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

type Ligne = { etat: string; app: string; cas: string; detail: string; version: string; ms: number };

const ICONE: Record<string, string> = {
  PASSE: '✅ PASSE        ',
  ECHOUE: '❌ ÉCHOUE       ',
  NON_ABOUTI: '⚪ NON ABOUTI   ',
  ATTENDU_ROUGE: '🟡 ATTENDU ROUGE',
};

class TroisEtats implements Reporter {
  private lignes: Ligne[] = [];
  private debut = Date.now();

  onTestEnd(test: TestCase, result: TestResult) {
    const a = (t: string) => test.annotations.filter((x) => x.type === t).map((x) => x.description ?? '');
    let etat = a('etat')[0];
    if (!etat) {
      // pas d'annotation : le cas a planté avant d'en poser une (timeout, crash) → échec franc
      etat = result.status === 'passed' ? 'PASSE' : 'ECHOUE';
    }
    const brut = a('detail').join(' · ') || (result.error?.message ?? '').split('\n')[0] || '';
    this.lignes.push({
      etat,
      app: a('app')[0] ?? 'hub',
      cas: a('cas')[0] ?? test.title,
      detail: brut.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 400),
      version: a('version')[0] ?? '',
      ms: result.duration,
    });
  }

  async onEnd(_r: FullResult) {
    const dir = path.join(__dirname, '.run');
    mkdirSync(dir, { recursive: true });
    const compte: Record<string, number> = {};
    for (const l of this.lignes) compte[l.etat] = (compte[l.etat] ?? 0) + 1;
    const out: string[] = [];
    out.push(`\n══ BATTERIE SYSTÈME SSO · ${new Date().toISOString()} · ${Math.round((Date.now() - this.debut) / 1000)} s ══`);
    for (const l of this.lignes) {
      out.push(`${ICONE[l.etat] ?? l.etat}  ${l.app.padEnd(11)} ${l.cas}`);
      if (l.etat !== 'PASSE' || l.detail) out.push(`${' '.repeat(18)}↳ ${l.detail}${l.version ? `   [version servie : ${l.version}]` : ''}`);
    }
    out.push(
      `\nBILAN  ✅ ${compte.PASSE ?? 0} passent · ❌ ${compte.ECHOUE ?? 0} échouent · ⚪ ${compte.NON_ABOUTI ?? 0} non aboutis · 🟡 ${compte.ATTENDU_ROUGE ?? 0} attendus rouges`,
    );
    const txt = out.join('\n');
    console.log(txt);
    writeFileSync(path.join(dir, 'resultat.txt'), txt + '\n');
    writeFileSync(
      path.join(dir, 'resultat.json'),
      JSON.stringify({ date: new Date().toISOString(), compte, lignes: this.lignes }, null, 2),
    );
  }

  printsToStdio() {
    return true;
  }
}

export default TroisEtats;

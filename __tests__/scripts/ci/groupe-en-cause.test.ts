// @vitest-environment node
/** scripts/ci/groupe-en-cause.sh : un déploiement rouge dit quel groupe, et si le Hub sert quand même la nouvelle version. */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const ligne = (g: string, promu: string, place: number, sain: number) => `${g.padEnd(16)}  ${g === 'stack' ? 'true ' : 'false'}        ${promu.padEnd(8)}  1        ${g === 'stack' ? 1 : 0}         ${place}       ${sain}        0          2026-11-24T15:54:53Z`;
const statut = (etat: string, ...l: string[]) =>
  `ID = hub\n\nLatest Deployment\nID          = ad289e9b\nStatus      = ${etat}\nDescription = x\n\nDeployed\nTask Group        Auto Revert  Promoted  Desired  Canaries  Placed  Healthy  Unhealthy  Progress Deadline\n${l.join('\n')}\n\nAllocations\nID  Node ID\n`;
const jouer = (entree: string) => {
  const r = spawnSync('bash', ['scripts/ci/groupe-en-cause.sh'], { input: entree, encoding: 'utf8' });
  return { code: r.status, texte: r.stdout };
};

describe('groupe en cause', () => {
  it('tout sain : 0, aucune erreur', () => {
    const r = jouer(statut('successful', ligne('atelier-8fa7e09d', 'N/A', 1, 1), ligne('stack', 'true', 1, 1)));
    expect(r).toMatchObject({ code: 0, texte: expect.stringContaining('NOUVELLE version servie') });
    expect(r.texte).not.toContain('::error::');
  });

  it('atelier en panne, Hub servi : nomme l\'atelier seul, et dit que le Hub sert', () => {
    const r = jouer(statut('failed', ligne('atelier-8fa7e09d', 'N/A', 1, 0), ligne('stack', 'true', 1, 1)));
    expect(r.code).toBe(1);
    expect(r.texte).toContain('groupe en cause : atelier-8fa7e09d (placé mais pas sain');
    expect(r.texte).toContain('NOUVELLE version servie');
    expect(r.texte).not.toContain('en cause : stack');
  });

  it('groupe implaçable : « aucune place trouvée » (déploiement encore running)', () => {
    const r = jouer(statut('running', ligne('programme', 'N/A', 0, 0), ligne('stack', 'true', 1, 1)));
    expect(r.texte).toContain('programme (aucune place trouvée');
  });

  it('stack en panne ou pas promu : le Hub ne sert PAS la nouvelle version', () => {
    expect(jouer(statut('failed', ligne('stack', 'false', 1, 0))).texte).toContain('NON servie');
    expect(jouer(statut('failed', ligne('programme', 'N/A', 1, 0), ligne('stack', 'false', 1, 1))).texte).toContain('NON servie');
  });

  it('illisible, vide ou sans stack : 2, jamais un faux vert', () => {
    for (const t of ['', 'Error querying job', statut('successful'), statut('successful', ligne('atelier-1', 'N/A', 1, 1)), statut('failed', 'stack  x  y')]) expect(jouer(t).code, t.slice(0, 40)).toBe(2);
  });
});

/** Mode programme : la forme qui porte l'enfermement (docs/CONTRAT-MCP.md). La preuve sur ce qui est servi : scripts/epreuve-programme.sh. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const lire = (f: string) => readFileSync(f, 'utf8');
const tache = (hcl: string, nom: string) => {
  const a = hcl.indexOf(`task "${nom}"`);
  const b = hcl.indexOf('\n    task "', a + 10);
  return a < 0 ? '' : hcl.slice(a, b < 0 ? undefined : b);
};

describe.each([['deploy/hub.nomad.hcl', 'hub'], ['deploy/hub-staging.nomad.hcl', 'hub-staging']])('%s', (fichier, p) => {
  const hcl = lire(fichier);
  const moteur = tache(hcl, `${p}-programme-moteur`);
  const passerelle = tache(hcl, `${p}-programme-passerelle`);

  it('le moteur : sans réseau, sans secret, lecture seule, quatre capacités, pas d\'élévation', () => {
    expect(moteur).toMatch(/network_mode\s+= "none"/);
    expect(moteur).toMatch(/readonly_rootfs = true/);
    expect(moteur).toMatch(/cap_drop\s+= \["ALL"\]/);
    expect(moteur).toMatch(/cap_add\s+= \["SETUID", "SETGID", "SYS_CHROOT", "KILL"\]/);
    expect(moteur).toMatch(/no-new-privileges:true/);
    expect(moteur).toMatch(/fsize = "0:0"/);
    expect(moteur).not.toMatch(/nomadVar|template \{|env \{|volume|identity|ports/);
  });

  it('la passerelle : aucun secret, aucune capacité', () => {
    expect(passerelle).toMatch(/cap_drop\s+= \["ALL"\]/);
    expect(passerelle).not.toMatch(/nomadVar|cap_add|volume|identity|root"/);
  });

  it.skipIf(p === 'hub-staging')('prod : un groupe à part, hors du nœud du Hub, dont la panne n\'annule pas un déploiement du Hub', () => {
    const g = hcl.slice(hcl.indexOf('group "programme"'));
    expect(g).toMatch(/auto_revert\s+= false/);
    expect(g).toMatch(/health_check\s+= "task_states"/);
    expect(g).not.toMatch(/ovh-prod/);
  });
});

it('prod : seul le groupe stack peut défaire un déploiement (un retour arrière de Nomad porte sur le job entier)', () => {
  const hcl = lire('deploy/hub.nomad.hcl').replace(/^\s*#.*$/gm, '');
  const apresStack = hcl.slice(hcl.search(/^  (dynamic "group"|group "(?!stack))/m));
  expect(hcl.match(/auto_revert\s+= true/g)).toHaveLength(1);
  expect(apresStack).not.toMatch(/auto_revert\s+= true/);
  expect(apresStack.match(/auto_revert\s+= false/g)?.length).toBeGreaterThanOrEqual(2);
});

it('staging : un seul groupe (Sablier refuse le job sinon, 24/11)', () => {
  expect(lire('deploy/hub-staging.nomad.hcl').match(/^  group "/gm)).toHaveLength(1);
});

describe('image', () => {
  const pkg = JSON.parse(lire('package.json')) as { devDependencies: Record<string, string> };
  const docker = lire('Dockerfile');
  it.each(['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'])('%s : la version éprouvée en test est celle de la prison', (n) => {
    expect(docker).toContain(`${n}@${pkg.devDependencies[n]}`);
  });
  it('la prison n\'emporte ni l\'épreuve, ni le superviseur, ni une dépendance de plus', () => {
    expect(docker.match(/^COPY .*prison.*/gm)).toEqual(['COPY --chmod=0444 programme/executeur.mjs /opt/programme/prison/app/executeur.mjs']);
    expect(docker).not.toMatch(/epreuve\.mjs/);
  });
  it('ce que le code d\'un client peut lire n\'est inscriptible par personne', () => {
    const copies = docker.match(/^COPY .*programme\/.*/gm) ?? [];
    expect(copies).toHaveLength(2);
    for (const c of copies) expect(c).toContain('--chmod=0444');
    expect(docker).toMatch(/rm -rf \/root\/\.npm && chmod -R a\+rX,a-w \/opt\/programme\n/);
  });
  it('image légère : chaque npm install retire son cache dans sa couche, les couches lourdes précèdent le Hub', () => {
    const runner = docker.slice(docker.indexOf('AS runner'), docker.indexOf('AS dev'));
    const couches = runner.split('\n').filter((l) => !l.startsWith('#')).join('\n').split(/\n(?=[A-Z]+ )/);
    const installs = couches.filter((c) => c.includes('npm install'));
    expect(installs).toHaveLength(4);
    for (const c of installs) expect(c).toMatch(/rm -rf[^\n]*\/root\/\.npm/);
    const hub = couches.findIndex((c) => c.includes('.next/standalone'));
    for (const x of ['mkdir -p /opt/prisma-cli', 'mkdir -p /opt/atelier', 'mkdir -p /opt/programme/prison']) {
      expect(couches.findIndex((c) => c.includes(x)), x).toBeGreaterThan(0);
      expect(couches.findIndex((c) => c.includes(x)), x).toBeLessThan(hub);
    }
    expect(couches.findIndex((c) => c.startsWith('ARG GIT_SHA')), 'le SHA change à chaque push').toBeGreaterThan(hub);
    expect(runner).not.toMatch(/chown -R nextjs:nodejs \/app/);
  });
  it('l\'exécuteur ne lit que son entrée : ni fichier, ni réseau, ni environnement', () => {
    const src = lire('programme/executeur.mjs').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src.match(/from '([^']+)'/g)).toEqual(["from 'node:readline'", "from 'quickjs-emscripten-core'", "from '@jitl/quickjs-wasmfile-release-sync'"]);
    expect(src).not.toMatch(/process\.env|import\(|require\(/);
  });
});

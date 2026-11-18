/**
 * Tests du garde-fou des routes d'atelier (`/dev/*`).
 *
 * C'est le test le plus important du lot onboarding : `isDevHarnessEnabled()`
 * est le verrou RUNTIME qui empêche une zone de développement, peuplée de
 * données fictives et sans aucune authentification, d'être joignable en
 * production. Le verrou BUILD (`pageExtensions` conditionnel dans
 * `next.config.js`) est le premier rempart ; celui-ci couvre le cas où
 * quelqu'un renommerait un `page.dev.tsx` en `page.tsx`.
 *
 * La règle testée est volontairement asymétrique : le moindre signal de
 * production doit suffire à fermer, et aucun signal de développement ne doit
 * pouvoir rouvrir ce qu'un signal de production a fermé. On teste donc
 * surtout les combinaisons contradictoires, parce que c'est là qu'un
 * garde-fou mal écrit s'ouvre.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { isDevHarnessEnabled } from '@/lib/dev/harness-guard';

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  DEPLOY_ENV: process.env.DEPLOY_ENV,
  DOMAIN: process.env.DOMAIN,
  NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
};

/** Repart d'un environnement neutre : aucun signal dans un sens ni l'autre. */
function clearEnv() {
  delete (process.env as Record<string, unknown>).NODE_ENV;
  delete process.env.DEPLOY_ENV;
  delete process.env.DOMAIN;
  delete process.env.NEXT_PUBLIC_DOMAIN;
  delete process.env.NEXT_PUBLIC_SITE_URL;
}

beforeEach(() => {
  clearEnv();
});

afterAll(() => {
  clearEnv();
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v !== undefined) (process.env as Record<string, unknown>)[k] = v;
  }
});

describe('isDevHarnessEnabled — verrou NODE_ENV', () => {
  it('ferme l’atelier quand NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('ouvre l’atelier en développement', () => {
    process.env.NODE_ENV = 'development';
    expect(isDevHarnessEnabled()).toBe(true);
  });

  it('ouvre l’atelier pendant les tests', () => {
    process.env.NODE_ENV = 'test';
    expect(isDevHarnessEnabled()).toBe(true);
  });
});

describe('isDevHarnessEnabled — verrou DEPLOY_ENV', () => {
  // DEPLOY_ENV est la variable injectée par le job Nomad. C'est elle qui
  // distingue un déploiement prod d'un déploiement staging, là où NODE_ENV
  // vaut 'production' des deux côtés (un build Next staging est un build de
  // production). Sans ce verrou, l'atelier serait ouvert sur la vraie prod.
  it('ferme l’atelier quand DEPLOY_ENV=prod', () => {
    process.env.DEPLOY_ENV = 'prod';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('ferme l’atelier quand DEPLOY_ENV=production', () => {
    process.env.DEPLOY_ENV = 'production';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('tolère la casse et les espaces autour de la valeur', () => {
    // Une variable d'env mal saisie dans un job Nomad ne doit pas rouvrir
    // l'atelier en prod par accident.
    for (const valeur of ['PROD', ' prod ', 'Production', '  PRODUCTION  ']) {
      process.env.DEPLOY_ENV = valeur;
      expect(isDevHarnessEnabled(), `DEPLOY_ENV=${JSON.stringify(valeur)}`).toBe(false);
    }
  });

  it('laisse l’atelier ouvert en staging', () => {
    process.env.DEPLOY_ENV = 'staging';
    expect(isDevHarnessEnabled()).toBe(true);
  });
});

describe('isDevHarnessEnabled — verrou domaine', () => {
  it('ferme l’atelier sur le domaine de production app.veridian.site', () => {
    process.env.DOMAIN = 'app.veridian.site';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('ferme aussi via NEXT_PUBLIC_DOMAIN et NEXT_PUBLIC_SITE_URL', () => {
    process.env.NEXT_PUBLIC_DOMAIN = 'app.veridian.site';
    expect(isDevHarnessEnabled()).toBe(false);

    delete process.env.NEXT_PUBLIC_DOMAIN;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('laisse l’atelier ouvert sur les domaines de travail', () => {
    for (const domaine of ['localhost:3000', 'dev.veridian.site', 'staging.veridian.site']) {
      clearEnv();
      process.env.DOMAIN = domaine;
      expect(isDevHarnessEnabled(), domaine).toBe(true);
    }
  });
});

describe('isDevHarnessEnabled — signaux contradictoires', () => {
  // Le cœur du garde-fou : les trois verrous sont indépendants et un seul
  // signal de production suffit à fermer. Un garde-fou qui exigerait un
  // accord des trois s'ouvrirait au premier oubli de configuration.
  it('un domaine de dev ne rouvre pas ce que DEPLOY_ENV=prod a fermé', () => {
    process.env.DOMAIN = 'localhost:3000';
    process.env.DEPLOY_ENV = 'prod';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('un DEPLOY_ENV de staging ne rouvre pas le domaine de production', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.DOMAIN = 'app.veridian.site';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('NODE_ENV=development ne rouvre pas un déploiement marqué prod', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEPLOY_ENV = 'prod';
    expect(isDevHarnessEnabled()).toBe(false);
  });

  it('n’ouvre que si AUCUN des trois signaux n’indique la production', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEPLOY_ENV = 'staging';
    process.env.DOMAIN = 'localhost:3000';
    expect(isDevHarnessEnabled()).toBe(true);
  });
});

describe('isDevHarnessEnabled — environnement vide', () => {
  it('ouvre l’atelier quand rien n’est configuré (poste de dev nu)', () => {
    // Sans aucune variable, `getEnvironment()` retombe sur 'development'.
    // C'est le comportement attendu en local : l'atelier doit marcher sans
    // configuration. Le risque prod est couvert par le verrou build, qui ne
    // dépend d'aucune variable d'exécution.
    expect(isDevHarnessEnabled()).toBe(true);
  });

  it('retourne toujours un booléen strict, jamais une valeur truthy', () => {
    process.env.DEPLOY_ENV = 'prod';
    expect(typeof isDevHarnessEnabled()).toBe('boolean');
    clearEnv();
    expect(typeof isDevHarnessEnabled()).toBe('boolean');
  });
});

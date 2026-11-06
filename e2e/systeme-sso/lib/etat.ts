/**
 * Trois états, jamais deux : PASSE, ECHOUE, NON_ABOUTI. Un quatrième, ATTENDU_ROUGE,
 * dit « échoue, et c'est prévu » : l'app sert une version sans le correctif.
 * Il ne casse pas la batterie, mais il est affiché avec la version relue.
 *
 * Règle : seule une ASSERTION fausse est un échec. Tout ce qui empêche de mesurer
 * (compte de test non créé, API admin muette, version non lue) est NON ABOUTI,
 * jamais un faux vert ni un faux rouge.
 */
import { test, type Browser, type TestInfo } from '@playwright/test';

import type { AppKey } from './cibles';
import { masquer } from './cibles';
import { estCorrige, versionsServies } from './versions';

export type Etat = 'PASSE' | 'ECHOUE' | 'NON_ABOUTI' | 'ATTENDU_ROUGE';

export class NonAbouti extends Error {
  constructor(raison: string) {
    super(raison);
    this.name = 'NonAbouti';
  }
}

function note(info: TestInfo, type: string, description: string) {
  info.annotations.push({ type, description: masquer(description).slice(0, 600) });
}

/**
 * Déclare un cas. `app` lie le cas à une app (version relue, « attendu rouge »),
 * `null` pour un cas Hub seul.
 */
export function cas(
  app: AppKey | null,
  titre: string,
  corps: (x: { browser: Browser; info: TestInfo }) => Promise<string | void>,
  options: { timeout?: number } = {},
) {
  const nom = `${app ?? 'hub'} · ${titre}`;
  test(
    nom,
    async ({ browser }, info) => {
      if (options.timeout) test.setTimeout(options.timeout);
      const v = await versionsServies();
      const hubCorrige = estCorrige('hub', v);
      const appCorrigee = app ? estCorrige(app, v) : true;
      const attendu = !(hubCorrige && appCorrigee);
      note(info, 'app', app ?? 'hub');
      note(info, 'cas', titre);
      if (app) note(info, 'version', `${v[app]?.lu ?? 'non lue'}`);
      note(info, 'version-hub', `${v.hub?.lu ?? 'non lue'}`);
      try {
        const detail = await corps({ browser, info });
        note(info, 'etat', 'PASSE' satisfies Etat);
        if (detail) note(info, 'detail', detail);
        if (attendu) {
          note(
            info,
            'detail',
            `passe alors que la version servie n'a pas le correctif : correctif déjà actif ou test trop faible`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const premiere = msg.split('\n').filter(Boolean).slice(0, 3).join(' ⏎ ');
        if (e instanceof NonAbouti) {
          note(info, 'etat', 'NON_ABOUTI' satisfies Etat);
          note(info, 'detail', msg);
          return;
        }
        if (attendu) {
          note(info, 'etat', 'ATTENDU_ROUGE' satisfies Etat);
          note(info, 'detail', premiere);
          return;
        }
        note(info, 'etat', 'ECHOUE' satisfies Etat);
        note(info, 'detail', premiere);
        throw e;
      }
    },
  );
}

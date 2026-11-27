/**
 * Garde : le code applicatif du Hub n'appelle plus Telegram (Robert, 23/11 puis 27/11 : Grafana seule source d'alertes, ligne `flux=alerte`
 * sur stdout, `lib/notifications/alerte.ts`). Une classe supprimée, pas un cas : aucune source applicative ne nomme l'API Telegram ni
 * ses variables (`TELEGRAM_*`, `ALERT_CHAT_ID`). Le relevé s'éprouve sur un texte qui en contient.
 */
import { describe, expect, it } from 'vitest';

import { code, parcourir } from './source';

const MOTIF = /api\.telegram\.org|TELEGRAM_[A-Z_]+|ALERT_CHAT_ID|sendTelegramAlert|notifications\/telegram/;

const SOURCES = [...['app', 'lib', 'utils', 'components', 'contexts', 'scripts'].flatMap(parcourir), 'auth.ts', 'middleware.ts']
  .filter((p) => /\.(ts|tsx|sh|mjs|js)$/.test(p))
  .filter((p) => !p.startsWith('scripts/ci/')); // le garde-secrets de la CI nomme les motifs qu'il interdit

describe('plus de Telegram dans le code applicatif', () => {
  it("outil : le motif voit l'ancien code", () => {
    expect(MOTIF.test("fetch(`https://api.telegram.org/bot${t}/sendMessage`)")).toBe(true);
    expect(MOTIF.test('process.env.ALERT_CHAT_ID')).toBe(true);
    expect(MOTIF.test('emettreAlerte({ gravite: "critique" })')).toBe(false);
    expect(SOURCES.length).toBeGreaterThan(50);
  });

  it('le job ne rend plus aucune variable Telegram (27/11 : TELEGRAM_BOT_TOKEN, ALERT_CHAT_ID retirés de deploy/hub.nomad.hcl)', () => {
    expect(MOTIF.test(code('deploy/hub.nomad.hcl'))).toBe(false);
  });

  it('aucune source applicative ne nomme Telegram', () => {
    const fautives = SOURCES.filter((f) => MOTIF.test(code(f)));
    expect(fautives).toEqual([]);
  });
});

/**
 * Double acceptation d'un secret de webhook pendant une rotation.
 *
 * Ces tests existent parce qu'une rotation sèche a déjà coupé la production :
 * le comportement à garantir n'est pas « le nouveau secret marche », c'est
 * « l'ANCIEN marche encore pendant la fenêtre, et plus du tout après ».
 * Les deux moitiés sont testées : l'acceptation ET le refus.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  matchRotatingSecret,
  matchRotatingSecretWith,
  readRotatingSecret,
} from '@/lib/webhooks/secret-rotation';

const NAME = 'TEST_ROTATION_SECRET';
const CURRENT = 'current-value-aaaaaaaaaaaaaaaaaaaaaaaa';
const PREVIOUS = 'previous-value-bbbbbbbbbbbbbbbbbbbbbbb';

describe('readRotatingSecret', () => {
  beforeEach(() => {
    delete process.env[NAME];
    delete process.env[`${NAME}_PREVIOUS`];
  });
  afterEach(() => {
    delete process.env[NAME];
    delete process.env[`${NAME}_PREVIOUS`];
  });

  it('renvoie null si la valeur courante est absente', () => {
    expect(readRotatingSecret(NAME)).toBeNull();
  });

  it('renvoie previous=null hors fenêtre de rotation', () => {
    process.env[NAME] = CURRENT;
    expect(readRotatingSecret(NAME)).toEqual({
      current: CURRENT,
      previous: null,
    });
  });

  it('expose les deux valeurs pendant la fenêtre de rotation', () => {
    process.env[NAME] = CURRENT;
    process.env[`${NAME}_PREVIOUS`] = PREVIOUS;
    expect(readRotatingSecret(NAME)).toEqual({
      current: CURRENT,
      previous: PREVIOUS,
    });
  });

  it('ignore une _PREVIOUS identique à la courante', () => {
    // Cas d'un déploiement où la variable a été laissée en place après la
    // fin de la rotation : ne doit pas faire croire à une fenêtre ouverte.
    process.env[NAME] = CURRENT;
    process.env[`${NAME}_PREVIOUS`] = CURRENT;
    expect(readRotatingSecret(NAME)?.previous).toBeNull();
  });

  it('ignore une _PREVIOUS vide', () => {
    process.env[NAME] = CURRENT;
    process.env[`${NAME}_PREVIOUS`] = '';
    expect(readRotatingSecret(NAME)?.previous).toBeNull();
  });
});

describe('matchRotatingSecret — jeton Bearer', () => {
  const open = { current: CURRENT, previous: PREVIOUS };
  const closed = { current: CURRENT, previous: null };

  it('accepte la valeur courante pendant la fenêtre', () => {
    expect(matchRotatingSecret(CURRENT, open)).toBe('current');
  });

  it('accepte la valeur héritée pendant la fenêtre', () => {
    expect(matchRotatingSecret(PREVIOUS, open)).toBe('previous');
  });

  it('refuse une valeur inconnue pendant la fenêtre', () => {
    expect(matchRotatingSecret('n-importe-quoi-dautre-cccccc', open)).toBe(
      'none',
    );
  });

  it("REFUSE la valeur héritée une fois la fenêtre fermée", () => {
    // C'est la moitié qui compte : sans ce refus, la rotation n'a rien changé
    // et le secret publié sur GitHub reste utilisable.
    expect(matchRotatingSecret(PREVIOUS, closed)).toBe('none');
  });

  it('accepte toujours la courante une fois la fenêtre fermée', () => {
    expect(matchRotatingSecret(CURRENT, closed)).toBe('current');
  });
});

describe('matchRotatingSecretWith — signature HMAC', () => {
  const body = '{"event_id":"x","event_type":"email.sent","tenant_id":"t"}';
  const ts = '1756300000000';

  const sign = (secret: string) =>
    createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  const verifyWith =
    (presentedSignature: string) =>
    (candidate: string): boolean =>
      sign(candidate) === presentedSignature;

  it('accepte une signature calculée avec la valeur courante', () => {
    expect(
      matchRotatingSecretWith(
        { current: CURRENT, previous: PREVIOUS },
        verifyWith(sign(CURRENT)),
      ),
    ).toBe('current');
  });

  it('accepte une signature calculée avec la valeur héritée', () => {
    expect(
      matchRotatingSecretWith(
        { current: CURRENT, previous: PREVIOUS },
        verifyWith(sign(PREVIOUS)),
      ),
    ).toBe('previous');
  });

  it('REFUSE la signature héritée une fois la fenêtre fermée', () => {
    expect(
      matchRotatingSecretWith(
        { current: CURRENT, previous: null },
        verifyWith(sign(PREVIOUS)),
      ),
    ).toBe('none');
  });

  it('évalue les DEUX candidats même quand le premier convient', () => {
    // Sinon le temps de réponse indique quelle valeur a servi, et un
    // attaquant apprend si sa valeur est l'ancienne ou la nouvelle.
    const verify = vi.fn().mockReturnValue(true);
    matchRotatingSecretWith({ current: CURRENT, previous: PREVIOUS }, verify);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

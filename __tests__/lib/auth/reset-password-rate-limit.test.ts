/**
 * Tests du module de rate-limiters de `POST /auth/reset_password`.
 *
 * Le comportement bout-en-bout (codes 429, Retry-After, anti-énumération) est
 * couvert par `__tests__/api/auth/reset-password.test.ts`. Ici on verrouille les
 * PARAMÈTRES eux-mêmes : ce sont des valeurs de sécurité, et une régression
 * silencieuse (quelqu'un qui « desserre un peu » un plafond pour débloquer un
 * test ou un client) doit faire échouer la CI plutôt que de passer inaperçue.
 *
 * On vérifie aussi l'étanchéité des trois buckets : ils doivent être des
 * instances distinctes, sinon saturer la demande de reset bloquerait aussi la
 * consommation du token, et un client ne pourrait plus utiliser le lien qu'il
 * vient de recevoir.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  resetRequestIpLimiter,
  resetRequestEmailLimiter,
  resetConsumeLimiter,
} from '@/lib/auth/reset-password-rate-limit';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Consomme `n` hits sur une clé et retourne le dernier résultat. */
function drain(limiter: { enforce: (k: string, now?: number) => any }, key: string, n: number) {
  let last;
  for (let i = 0; i < n; i++) last = limiter.enforce(key);
  return last;
}

beforeEach(() => {
  resetRequestIpLimiter.reset();
  resetRequestEmailLimiter.reset();
  resetConsumeLimiter.reset();
});

describe('reset-password rate-limiters — plafonds', () => {
  it('demande par IP : 5 passent, la 6e est refusée', () => {
    for (let i = 1; i <= 5; i++) {
      expect(resetRequestIpLimiter.enforce('1.2.3.4').ok, `hit #${i}`).toBe(true);
    }
    expect(resetRequestIpLimiter.enforce('1.2.3.4').ok).toBe(false);
  });

  it('demande par email : 4 passent, la 5e est refusée', () => {
    // Volontairement bas : chaque hit autorisé = un vrai mail dans la boîte de
    // la cible. C'est le garde-fou anti mail-bombing.
    for (let i = 1; i <= 4; i++) {
      expect(resetRequestEmailLimiter.enforce('cible@test.io').ok, `hit #${i}`).toBe(true);
    }
    expect(resetRequestEmailLimiter.enforce('cible@test.io').ok).toBe(false);
  });

  it('consommation par IP : 10 passent, la 11e est refusée', () => {
    for (let i = 1; i <= 10; i++) {
      expect(resetConsumeLimiter.enforce('1.2.3.4').ok, `hit #${i}`).toBe(true);
    }
    expect(resetConsumeLimiter.enforce('1.2.3.4').ok).toBe(false);
  });
});

describe('reset-password rate-limiters — fenêtres', () => {
  // Les fenêtres sont longues à dessein : sur une route qui envoie un mail, le
  // coût réel se mesure à l'heure, et un plafond à la minute ne gêne pas un
  // attaquant qui lisse son débit. On l'assert via le temps injecté plutôt
  // qu'en attendant réellement.
  it('la fenêtre IP de la demande dure 15 min, pas 1 min', () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) resetRequestIpLimiter.enforce('9.9.9.9', t0);

    // 5 minutes plus tard : toujours bloqué (une fenêtre d'1 min aurait rouvert).
    expect(resetRequestIpLimiter.enforce('9.9.9.9', t0 + 5 * MINUTE).ok).toBe(false);
    // Au-delà de 15 min : rouvert.
    expect(resetRequestIpLimiter.enforce('9.9.9.9', t0 + 15 * MINUTE + 1).ok).toBe(true);
  });

  it('la fenêtre email de la demande dure 1 h', () => {
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) resetRequestEmailLimiter.enforce('v@test.io', t0);

    // 30 min plus tard : la victime ne doit pas recevoir un 5e mail.
    expect(resetRequestEmailLimiter.enforce('v@test.io', t0 + 30 * MINUTE).ok).toBe(false);
    expect(resetRequestEmailLimiter.enforce('v@test.io', t0 + HOUR + 1).ok).toBe(true);
  });

  it('la fenêtre de consommation dure 1 min', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) resetConsumeLimiter.enforce('8.8.8.8', t0);
    expect(resetConsumeLimiter.enforce('8.8.8.8', t0 + 30_000).ok).toBe(false);
    expect(resetConsumeLimiter.enforce('8.8.8.8', t0 + MINUTE + 1).ok).toBe(true);
  });
});

describe('reset-password rate-limiters — étanchéité', () => {
  it('les trois limiters sont des buckets distincts', () => {
    // Saturer la demande par IP ne doit pas bloquer la consommation du token
    // depuis la même IP : sinon un client qui a spammé « mot de passe oublié »
    // ne pourrait plus se servir du lien qu'il vient de recevoir.
    drain(resetRequestIpLimiter, '7.7.7.7', 6);
    expect(resetRequestIpLimiter.enforce('7.7.7.7').ok).toBe(false);
    expect(resetConsumeLimiter.enforce('7.7.7.7').ok).toBe(true);
    expect(resetRequestEmailLimiter.enforce('7.7.7.7').ok).toBe(true);
  });

  it('deux clés différentes ne partagent pas leur compteur', () => {
    drain(resetRequestEmailLimiter, 'a@test.io', 5);
    expect(resetRequestEmailLimiter.enforce('a@test.io').ok).toBe(false);
    expect(resetRequestEmailLimiter.enforce('b@test.io').ok).toBe(true);
  });
});

describe('reset-password rate-limiters — Retry-After', () => {
  it('un refus expose un délai de réessai strictement positif', () => {
    drain(resetConsumeLimiter, '5.5.5.5', 10);
    const blocked = resetConsumeLimiter.enforce('5.5.5.5');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      // Jamais au-delà de la fenêtre : un client bloqué doit savoir qu'il
      // patiente une minute, pas un temps indéterminé.
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('le délai de réessai de la demande par email reste borné à sa fenêtre', () => {
    drain(resetRequestEmailLimiter, 'w@test.io', 4);
    const blocked = resetRequestEmailLimiter.enforce('w@test.io');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });
});

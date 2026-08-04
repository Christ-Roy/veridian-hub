/**
 * Tests POST /auth/reset_password — rate-limit + anti-énumération (2026-07-28).
 *
 * La route était la seule route d'auth publique du Hub sans plafond, alors que
 * chaque « demande » déclenche un envoi Brevo. On couvre :
 *   1. Plafond par IP sur la demande (5 / 15 min).
 *   2. Plafond par EMAIL VISÉ (4 / h) — tient même quand l'attaquant tourne
 *      d'IP, c'est le vrai garde-fou anti mail-bombing.
 *   3. Plafond par IP sur la consommation du token (10 / min).
 *   4. Anti-énumération : email existant et inexistant répondent pareil, et
 *      le 429 par email ne dépend pas de l'existence du compte.
 *   5. Le flow reste fonctionnel : mail envoyé, token consommé, création de
 *      l'Account credentials pour un user qui n'en a pas (première connexion).
 *   6. Bypass E2E staging (`x-veridian-e2e-bypass-ratelimit`) + garde-fou prod.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type UserRecord = { id: string; email: string; accounts: any[] };

const userStore: Map<string, UserRecord> = new Map();
const tokenStore: Map<string, { identifier: string; token: string; expires: Date }> = new Map();
const accountCreates: any[] = [];
const accountUpdates: any[] = [];

const sendMailMock = vi.fn(async () => undefined);

vi.mock('@/lib/email/send', () => ({
  sendMail: (...args: any[]) => sendMailMock(...args),
}));

vi.mock('@/utils/helpers', () => ({
  getURL: (path = '') => `https://hub.test${path}`,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) => userStore.get(where.email) ?? null),
    },
    verificationToken: {
      findUnique: vi.fn(async ({ where }: any) => tokenStore.get(where.token) ?? null),
      create: vi.fn(async ({ data }: any) => {
        tokenStore.set(data.token, data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        for (const [k, v] of Array.from(tokenStore)) {
          if (v.identifier === where.identifier) tokenStore.delete(k);
        }
        return { count: 0 };
      }),
      delete: vi.fn(async ({ where }: any) => {
        tokenStore.delete(where.token);
        return {};
      }),
    },
    account: {
      create: vi.fn(async ({ data }: any) => {
        accountCreates.push(data);
        return { id: 'acc-new', ...data };
      }),
      update: vi.fn(async (args: any) => {
        accountUpdates.push(args);
        return { id: args.where.id };
      }),
    },
  },
}));

async function loadRoute() {
  return import('@/app/(auth)/auth/reset_password/route');
}

async function resetLimiters() {
  // Les limiters vivent dans leur propre module : un route.ts Next.js ne peut
  // pas exporter autre chose que ses handlers sans casser le build de prod.
  const mod = await import('@/lib/auth/reset-password-rate-limit');
  mod.resetRequestIpLimiter.reset();
  mod.resetRequestEmailLimiter.reset();
  mod.resetConsumeLimiter.reset();
}

function makeReq(body: any, ip = '10.0.0.1', extraHeaders: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: new Headers({ 'x-forwarded-for': ip, ...extraHeaders }),
  } as any;
}

function seedUser(email: string, accounts: any[] = []) {
  userStore.set(email, { id: `u-${email}`, email, accounts });
}

beforeEach(async () => {
  vi.clearAllMocks();
  userStore.clear();
  tokenStore.clear();
  accountCreates.length = 0;
  accountUpdates.length = 0;
  await resetLimiters();
});

describe('POST /auth/reset_password — validation', () => {
  it('rejette un JSON invalide (400)', async () => {
    const { POST } = await loadRoute();
    const res = await POST({
      json: async () => {
        throw new Error('bad');
      },
      headers: new Headers({ 'x-forwarded-for': '10.1.0.1' }),
    } as any);
    expect(res.status).toBe(400);
  });

  it('rejette un payload qui ne matche ni demande ni consommation (400)', async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ nope: true }, '10.1.0.2'));
    expect(res.status).toBe(400);
  });

  it('rejette un password > 72 bytes sur la consommation (anti-DoS bcrypt)', async () => {
    // bcrypt tronque à 72 bytes : au-delà = zéro sécurité en plus, mais un
    // hash CPU sur payload XXL. Le schema doit border AVANT tout hash → le
    // payload ne matche plus consumeSchema, donc 400 (jamais un 200).
    const { POST } = await loadRoute();
    const res = await POST(
      makeReq({ token: 'a'.repeat(32), password: 'A'.repeat(2 * 1024 * 1024) }, '10.1.0.3')
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/reset_password — rate-limit demande par IP', () => {
  it('6e demande depuis la même IP → 429 + Retry-After', async () => {
    const { POST } = await loadRoute();
    // Emails tous différents pour isoler le plafond IP du plafond email.
    for (let i = 0; i < 5; i++) {
      const res = await POST(makeReq({ email: `flood-${i}@test.io` }, '10.2.0.1'));
      expect(res.status, `demande #${i} doit passer`).toBe(200);
    }
    const blocked = await POST(makeReq({ email: 'flood-6@test.io' }, '10.2.0.1'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('une autre IP n’est pas affectée par le plafond de la première', async () => {
    const { POST } = await loadRoute();
    for (let i = 0; i < 6; i++) {
      await POST(makeReq({ email: `a-${i}@test.io` }, '10.2.0.2'));
    }
    const other = await POST(makeReq({ email: 'fresh@test.io' }, '10.2.0.3'));
    expect(other.status).toBe(200);
  });
});

describe('POST /auth/reset_password — rate-limit par email visé (anti mail-bombing)', () => {
  it('5e demande sur le MÊME email → 429 même si l’attaquant change d’IP à chaque coup', async () => {
    // Le cœur du fix : un plafond purement IP se contourne en tournant les
    // proxies. Ici la clé est la CIBLE, donc la victime est protégée.
    const { POST } = await loadRoute();
    const victim = 'victime@test.io';
    seedUser(victim);

    for (let i = 0; i < 4; i++) {
      const res = await POST(makeReq({ email: victim }, `10.3.0.${i + 1}`));
      expect(res.status, `demande #${i} depuis une IP neuve doit passer`).toBe(200);
    }

    const blocked = await POST(makeReq({ email: victim }, '10.3.0.250'));
    expect(blocked.status, 'IP neuve mais même cible → doit être bloqué').toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('plafonne le nombre de mails réellement envoyés à la victime', async () => {
    const { POST } = await loadRoute();
    const victim = 'bombing@test.io';
    seedUser(victim);

    for (let i = 0; i < 12; i++) {
      await POST(makeReq({ email: victim }, `10.4.0.${i + 1}`));
    }
    // 4 mails max sur la fenêtre, pas 12.
    expect(sendMailMock).toHaveBeenCalledTimes(4);
  });

  it('la clé email est normalisée (casse + espaces) — pas de contournement', async () => {
    const { POST } = await loadRoute();
    seedUser('norm@test.io');

    const variants = ['norm@test.io', 'NORM@test.io', 'Norm@Test.IO', 'norm@TEST.io'];
    for (const v of variants) {
      const res = await POST(makeReq({ email: v }, '10.5.0.1'));
      expect(res.status).toBe(200);
    }
    // 5e variante → le plafond email doit avoir compté les 4 comme la même cible
    const blocked = await POST(makeReq({ email: 'NoRm@TeSt.Io' }, '10.5.0.2'));
    expect(blocked.status).toBe(429);
  });

  it('un email cible bloqué n’empêche pas une autre cible depuis la même IP', async () => {
    const { POST } = await loadRoute();
    for (let i = 0; i < 4; i++) {
      await POST(makeReq({ email: 'cible-a@test.io' }, `10.6.0.${i + 1}`));
    }
    const other = await POST(makeReq({ email: 'cible-b@test.io' }, '10.6.0.99'));
    expect(other.status).toBe(200);
  });
});

describe('POST /auth/reset_password — anti-énumération de comptes', () => {
  it('email inexistant et email existant renvoient la même réponse', async () => {
    const { POST } = await loadRoute();
    seedUser('existe@test.io');

    const known = await POST(makeReq({ email: 'existe@test.io' }, '10.7.0.1'));
    const unknown = await POST(makeReq({ email: 'inconnu@test.io' }, '10.7.0.2'));

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it('le 429 par email ne dépend PAS de l’existence du compte', async () => {
    // Le limiter email est appliqué AVANT le lookup user : un attaquant ne peut
    // pas déduire « ce compte existe » du fait de recevoir un 429 (ou pas).
    const { POST } = await loadRoute();

    const drain = async (email: string) => {
      for (let i = 0; i < 4; i++) await POST(makeReq({ email }, `10.8.${i}.1`));
      return POST(makeReq({ email }, '10.8.99.1'));
    };

    seedUser('reel@test.io');
    const blockedReal = await drain('reel@test.io');
    const blockedFake = await drain('fantome@test.io');

    expect(blockedReal.status).toBe(429);
    expect(blockedFake.status, 'un email inexistant doit se faire limiter pareil').toBe(429);
    expect(await blockedReal.json()).toEqual(await blockedFake.json());
  });

  it('n’attend pas l’envoi du mail pour répondre (pas de fuite par timing)', async () => {
    // Avant le fix : email inexistant = réponse immédiate, email existant =
    // attente de l'appel Brevo. L'écart était chronométrable. On simule un
    // provider lent : la réponse ne doit PAS l'attendre.
    const { POST } = await loadRoute();
    seedUser('lent@test.io');

    let mailResolved = false;
    sendMailMock.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) =>
          setTimeout(() => {
            mailResolved = true;
            resolve(undefined);
          }, 300)
        ) as any
    );

    const res = await POST(makeReq({ email: 'lent@test.io' }, '10.9.0.1'));
    expect(res.status).toBe(200);
    expect(mailResolved, 'la réponse ne doit pas attendre le provider mail').toBe(false);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('un échec du provider mail ne casse pas la réponse ni le process', async () => {
    const { POST } = await loadRoute();
    seedUser('brevoko@test.io');
    sendMailMock.mockRejectedValueOnce(new Error('Brevo down') as never);

    const res = await POST(makeReq({ email: 'brevoko@test.io' }, '10.10.0.1'));
    expect(res.status).toBe(200);
    // Laisse le microtask du .catch() s'exécuter : pas d'unhandled rejection.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('POST /auth/reset_password — rate-limit consommation du token', () => {
  it('11e tentative de consommation depuis la même IP → 429', async () => {
    const { POST } = await loadRoute();
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        makeReq({ token: `bogus-token-${i}-padding`, password: 'longenough' }, '10.11.0.1')
      );
      // Token inconnu → 400, mais la tentative compte dans la fenêtre.
      expect(res.status).toBe(400);
    }
    const blocked = await POST(
      makeReq({ token: 'bogus-token-11-padding', password: 'longenough' }, '10.11.0.1')
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('le plafond de consommation est indépendant de celui des demandes', async () => {
    const { POST } = await loadRoute();
    // On sature les demandes depuis une IP…
    for (let i = 0; i < 6; i++) {
      await POST(makeReq({ email: `x-${i}@test.io` }, '10.12.0.1'));
    }
    // …la consommation d'un token depuis la même IP doit rester possible
    // (sinon un client qui a spammé « mot de passe oublié » ne pourrait plus
    // utiliser le lien qu'il vient de recevoir).
    const res = await POST(
      makeReq({ token: 'unknown-token-padding', password: 'longenough' }, '10.12.0.1')
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/reset_password — le flow reste fonctionnel', () => {
  it('envoie un mail avec un lien de reset pour un compte existant', async () => {
    const { POST } = await loadRoute();
    seedUser('flow@test.io');

    const res = await POST(makeReq({ email: 'flow@test.io' }, '10.13.0.1'));
    expect(res.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const payload = sendMailMock.mock.calls[0][0] as any;
    expect(payload.to).toBe('flow@test.io');
    expect(payload.html).toContain('/auth/reset?token=');
    // Un token a bien été persisté et il est dans le lien.
    const [token] = Array.from(tokenStore.keys());
    expect(token).toBeTruthy();
    expect(payload.html).toContain(token);
  });

  it('consomme un token valide et met à jour le hash du compte credentials', async () => {
    const { POST } = await loadRoute();
    seedUser('consume@test.io', [
      { id: 'acc-1', provider: 'credentials', access_token: 'ancien-hash' },
    ]);
    tokenStore.set('tok-valide-0123456789', {
      identifier: 'consume@test.io',
      token: 'tok-valide-0123456789',
      expires: new Date(Date.now() + 60_000),
    });

    const res = await POST(
      makeReq({ token: 'tok-valide-0123456789', password: 'nouveaupass' }, '10.14.0.1')
    );
    expect(res.status).toBe(200);
    expect(accountUpdates).toHaveLength(1);
    expect(accountUpdates[0].where.id).toBe('acc-1');
    expect(accountUpdates[0].data.access_token).not.toBe('ancien-hash');
    // Token consommé → supprimé.
    expect(tokenStore.has('tok-valide-0123456789')).toBe(false);
  });

  it('PREMIÈRE CONNEXION : crée l’Account credentials si le user n’en a pas', async () => {
    // Cas critique : cette route sert de flow de première connexion pour les
    // clients sans mot de passe. Le rate-limit ne doit pas l'avoir cassé.
    const { POST } = await loadRoute();
    seedUser('premiere@test.io', []);
    tokenStore.set('tok-premiere-0123456789', {
      identifier: 'premiere@test.io',
      token: 'tok-premiere-0123456789',
      expires: new Date(Date.now() + 60_000),
    });

    const res = await POST(
      makeReq({ token: 'tok-premiere-0123456789', password: 'motdepasse1' }, '10.15.0.1')
    );
    expect(res.status).toBe(200);
    expect(accountCreates).toHaveLength(1);
    expect(accountCreates[0].provider).toBe('credentials');
    expect(accountCreates[0].providerAccountId).toBe('premiere@test.io');
    expect(accountCreates[0].access_token).toBeTruthy();
  });

  it('un client qui se rate 3 fois n’est PAS bloqué (plafond pas trop serré)', async () => {
    // Garde-fou anti-régression : le plafond doit protéger sans punir un
    // utilisateur légitime qui redemande un lien deux ou trois fois.
    const { POST } = await loadRoute();
    seedUser('maladroit@test.io');
    for (let i = 0; i < 3; i++) {
      const res = await POST(makeReq({ email: 'maladroit@test.io' }, '10.16.0.1'));
      expect(res.status, `tentative légitime #${i} doit passer`).toBe(200);
    }
  });

  it('refuse un token expiré (400) et le purge', async () => {
    const { POST } = await loadRoute();
    seedUser('expire@test.io', []);
    tokenStore.set('tok-expire-0123456789', {
      identifier: 'expire@test.io',
      token: 'tok-expire-0123456789',
      expires: new Date(Date.now() - 1000),
    });

    const res = await POST(
      makeReq({ token: 'tok-expire-0123456789', password: 'longenough' }, '10.17.0.1')
    );
    expect(res.status).toBe(400);
    expect(tokenStore.has('tok-expire-0123456789')).toBe(false);
  });
});

describe('POST /auth/reset_password — bypass E2E staging', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_BYPASS_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  const BYPASS_SECRET = 'z'.repeat(48); // ≥ 32 chars

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS_SECRET;
  });

  afterEach(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_BYPASS_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_BYPASS_SECRET;
  });

  const withBypass = (body: any, secret = BYPASS_SECRET) =>
    makeReq(body, '10.20.0.1', { 'x-veridian-e2e-bypass-ratelimit': secret });

  it('bypass valide en staging : 12 demandes sur la même cible passent', async () => {
    const { POST } = await loadRoute();
    seedUser('e2e@test.io');
    for (let i = 0; i < 12; i++) {
      const res = await POST(withBypass({ email: 'e2e@test.io' }));
      expect(res.status, `demande #${i} doit passer via bypass`).toBe(200);
    }
  });

  it('GARDE-FOU PROD : le header est ignoré, le plafond email s’applique', async () => {
    process.env.DEPLOY_ENV = 'prod';
    const { POST } = await loadRoute();
    seedUser('prod@test.io');
    for (let i = 0; i < 4; i++) {
      expect((await POST(withBypass({ email: 'prod@test.io' }))).status).toBe(200);
    }
    const blocked = await POST(withBypass({ email: 'prod@test.io' }));
    expect(blocked.status, 'PROD doit ignorer le header de bypass').toBe(429);
  });

  it('header bidon (même longueur) → bypass refusé, plafond normal', async () => {
    const { POST } = await loadRoute();
    seedUser('wrong@test.io');
    const wrong = 'y'.repeat(48);
    for (let i = 0; i < 4; i++) {
      expect((await POST(withBypass({ email: 'wrong@test.io' }, wrong))).status).toBe(200);
    }
    const blocked = await POST(withBypass({ email: 'wrong@test.io' }, wrong));
    expect(blocked.status).toBe(429);
  });
});

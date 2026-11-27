/**
 * Tests pour lib/auth/rate-limit.ts
 *
 * Couvre :
 *  - cap respecté (N requêtes OK, N+1 = bloquée)
 *  - fenêtre glissante (les hits anciens sortent du compte)
 *  - retryAfterSeconds positif et cohérent
 *  - extractClientIp : la clé ne dépend d'aucun en-tête écrit par l'appelant (D4)
 *  - constructor refuse les valeurs invalides
 *  - shouldBypassRateLimit : triple garde-fou anti-fuite prod
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  RateLimiter,
  extractClientIp,
  shouldBypassRateLimit,
} from '@/lib/auth/rate-limit';

describe('RateLimiter', () => {
  // Fenêtre fixe alignée sur l'horloge (VER-270) : le compte est partagé en base, pas en mémoire.
  it('laisse passer jusqu\'au cap, refuse au-delà', async () => {
    const rl = new RateLimiter({ capacity: 3, windowMs: 1000, name: 'test-cap' });
    const t = 1_000_000;
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
    const blocked = await rl.enforce('ip1', t);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.remaining).toBe(0);
    }
  });

  it('compte indépendamment par key (IP)', async () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'test-cle' });
    const t = 1_000_000;
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
    expect((await rl.enforce('ip1', t)).ok).toBe(false);
    // ip2 démarre frais
    expect((await rl.enforce('ip2', t)).ok).toBe(true);
    expect((await rl.enforce('ip2', t)).ok).toBe(true);
    expect((await rl.enforce('ip2', t)).ok).toBe(false);
  });

  it('fenêtre glissante : deux fenêtres plus tard, le compte repart', async () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'test-fenetre' });
    const t0 = 1_000_000; // début de fenêtre (multiple de 1000)
    expect((await rl.enforce('ip1', t0)).ok).toBe(true);
    expect((await rl.enforce('ip1', t0 + 100)).ok).toBe(true);
    expect((await rl.enforce('ip1', t0 + 200)).ok).toBe(false);
    expect((await rl.enforce('ip1', t0 + 2000)).ok).toBe(true);
  });

  // Rafale à cheval sur la frontière : la fenêtre fixe laisserait passer 5 + 5 (ici 10 sur 20 ms).
  it('RAFALE À LA FRONTIÈRE : 5 hits juste avant la frontière, 5 juste après, aucun du second lot ne passe', async () => {
    const rl = new RateLimiter({ capacity: 5, windowMs: 1000, name: 'test-frontiere' });
    const t0 = 1_000_000;
    const avant = [];
    for (let i = 0; i < 5; i++) avant.push(await rl.enforce('ip1', t0 + 990));
    expect(avant.filter((r) => r.ok).length).toBe(5);
    const apres = [];
    for (let i = 0; i < 5; i++) apres.push(await rl.enforce('ip1', t0 + 1010));
    expect(apres.filter((r) => r.ok).length).toBe(0);
  });

  it('un refus rend le délai exact jusqu\'à la fenêtre suivante (Retry-After)', async () => {
    const rl = new RateLimiter({ capacity: 1, windowMs: 10_000, name: 'test-retry' });
    const t0 = 1_000_000;
    await rl.enforce('ip1', t0);
    const refus = await rl.enforce('ip1', t0 + 2_500);
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.retryAfterSeconds).toBe(8);
  });

  it('les tentatives refusées comptent aussi (pas de bypass)', async () => {
    const rl = new RateLimiter({ capacity: 1, windowMs: 1000, name: 'test-refus' });
    const t = 1_000_000;
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
    expect((await rl.enforce('ip1', t)).ok).toBe(false);
    expect((await rl.enforce('ip1', t)).ok).toBe(false);
    expect((await rl.enforce('ip1', t)).ok).toBe(false);
    expect((await rl.enforce('ip1', t)).ok).toBe(false);
  });

  it('remaining décompte correctement les tentatives autorisées', async () => {
    const rl = new RateLimiter({ capacity: 3, windowMs: 1000, name: 'test-remaining' });
    const t = 1_000_000;
    const r1 = await rl.enforce('ip1', t);
    expect(r1.ok && r1.remaining).toBe(2);
    const r2 = await rl.enforce('ip1', t);
    expect(r2.ok && r2.remaining).toBe(1);
    const r3 = await rl.enforce('ip1', t);
    expect(r3.ok && r3.remaining).toBe(0);
  });

  it('reset() vide la fenêtre du limiteur', async () => {
    const rl = new RateLimiter({ capacity: 1, windowMs: 1000, name: 'test-reset' });
    const t = 1_000_000;
    await rl.enforce('ip1', t);
    expect((await rl.enforce('ip1', t)).ok).toBe(false);
    await rl.reset();
    expect((await rl.enforce('ip1', t)).ok).toBe(true);
  });

  it('depasse() lit sans compter : un appel réussi ne consomme rien, le plafond atteint bloque', async () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'test-depasse' });
    const t = 1_000_000;
    expect((await rl.depasse('ip1', t)).ok).toBe(true);
    expect((await rl.depasse('ip1', t)).ok).toBe(true);
    await rl.enforce('ip1', t);
    await rl.enforce('ip1', t);
    expect((await rl.depasse('ip1', t)).ok).toBe(false);
  });

  it('panne de base : refus fermé et journalisé, jamais un passage', async () => {
    const { installerMagasin, magasinEnMemoire } = await import('@/lib/auth/compteurs');
    const erreur = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installerMagasin({
      incrementer: async () => { throw new Error('base muette'); },
      lire: async () => { throw new Error('base muette'); },
      vider: async () => undefined,
      menage: async () => undefined,
    });
    try {
      const rl = new RateLimiter({ capacity: 5, windowMs: 1000, name: 'test-panne' });
      const r = await rl.enforce('ip1', 1_000_000);
      expect(r.ok).toBe(false);
      expect((await rl.depasse('ip1', 1_000_000)).ok).toBe(false);
      expect(erreur.mock.calls.some((c) => String(c[0]).includes('[ratelimit-indisponible]'))).toBe(true);
    } finally {
      installerMagasin(magasinEnMemoire());
      erreur.mockRestore();
    }
  });

  it('constructor refuse capacity <= 0', async () => {
    expect(() => new RateLimiter({ capacity: 0, windowMs: 1000, name: 'x' })).toThrow();
    expect(() => new RateLimiter({ capacity: -1, windowMs: 1000, name: 'x' })).toThrow();
  });

  it('constructor refuse windowMs <= 0', async () => {
    expect(() => new RateLimiter({ capacity: 1, windowMs: 0, name: 'x' })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, windowMs: -100, name: 'x' })).toThrow();
  });
});

describe('extractClientIp (clé des limiteurs, détail : ip-client.test.ts)', () => {
  it('D4 : des en-têtes forgés par un appelant direct ne changent pas sa clé', async () => {
    const rl = new RateLimiter({ capacity: 5, windowMs: 60_000, name: 'd4' });
    let last = { ok: true } as { ok: boolean };
    for (let i = 0; i < 6; i++) {
      // cf-connecting-ip : celui que l'appelant écrit ; X-Forwarded-For : ce que Traefik transmet (pair TCP seul).
      last = (await rl.enforce(extractClientIp(new Headers({ 'cf-connecting-ip': `9.9.9.${i}`, 'x-real-ip': `8.8.8.${i}`, 'x-forwarded-for': '1.1.1.1' }))));
    }
    expect(last.ok).toBe(false);
  });
});

describe('exported limiter instances', () => {
  it('exports adminApiLimiter avec capacity 30/min (anti-brute-force secret)', async () => {
    const { adminApiLimiter } = await import('@/lib/auth/rate-limit');
    adminApiLimiter.reset();
    // 30 hits doivent passer, 31e refusée
    for (let i = 0; i < 30; i++) {
      expect((await adminApiLimiter.enforce('test-ip')).ok).toBe(true);
    }
    expect((await adminApiLimiter.enforce('test-ip')).ok).toBe(false);
    adminApiLimiter.reset();
  });

  it('exports oauthStartLimiter avec capacity 10/min', async () => {
    const { oauthStartLimiter } = await import('@/lib/auth/rate-limit');
    oauthStartLimiter.reset();
    for (let i = 0; i < 10; i++) {
      expect((await oauthStartLimiter.enforce('test-ip-oauth')).ok).toBe(true);
    }
    expect((await oauthStartLimiter.enforce('test-ip-oauth')).ok).toBe(false);
    oauthStartLimiter.reset();
  });

  it('exports oauthCallbackLimiter avec capacity 30/min', async () => {
    const { oauthCallbackLimiter } = await import('@/lib/auth/rate-limit');
    oauthCallbackLimiter.reset();
    for (let i = 0; i < 30; i++) {
      expect((await oauthCallbackLimiter.enforce('test-ip-cb')).ok).toBe(true);
    }
    expect((await oauthCallbackLimiter.enforce('test-ip-cb')).ok).toBe(false);
    oauthCallbackLimiter.reset();
  });

  it('exports signupLimiter avec capacity 5/min (anti-DoS signup public)', async () => {
    const { signupLimiter } = await import('@/lib/auth/rate-limit');
    signupLimiter.reset();
    for (let i = 0; i < 5; i++) {
      expect((await signupLimiter.enforce('test-ip-signup')).ok).toBe(true);
    }
    expect((await signupLimiter.enforce('test-ip-signup')).ok).toBe(false);
    signupLimiter.reset();
  });

  it('exports credentialsLoginLimiter avec capacity 5/min (anti-brute-force password)', async () => {
    const { credentialsLoginLimiter } = await import('@/lib/auth/rate-limit');
    credentialsLoginLimiter.reset();
    for (let i = 0; i < 5; i++) {
      expect((await credentialsLoginLimiter.enforce('test-ip-creds')).ok).toBe(true);
    }
    expect((await credentialsLoginLimiter.enforce('test-ip-creds')).ok).toBe(false);
    credentialsLoginLimiter.reset();
  });

  it('exports invitationCreateLimiter avec capacity 60/min (anti-flood HMAC)', async () => {
    const { invitationCreateLimiter } = await import('@/lib/auth/rate-limit');
    invitationCreateLimiter.reset();
    for (let i = 0; i < 60; i++) {
      expect((await invitationCreateLimiter.enforce('test-ip-inv')).ok).toBe(true);
    }
    expect((await invitationCreateLimiter.enforce('test-ip-inv')).ok).toBe(false);
    invitationCreateLimiter.reset();
  });

  it('exports invitationVerifyLimiter avec capacity 30/min (anti brute-force token)', async () => {
    const { invitationVerifyLimiter } = await import('@/lib/auth/rate-limit');
    invitationVerifyLimiter.reset();
    for (let i = 0; i < 30; i++) {
      expect((await invitationVerifyLimiter.enforce('test-ip-verify')).ok).toBe(true);
    }
    expect((await invitationVerifyLimiter.enforce('test-ip-verify')).ok).toBe(false);
    invitationVerifyLimiter.reset();
  });

  it('exports onboardingVerifyLimiter avec capacity 30/min (anti scan token première connexion)', async () => {
    const { onboardingVerifyLimiter } = await import('@/lib/auth/rate-limit');
    onboardingVerifyLimiter.reset();
    for (let i = 0; i < 30; i++) {
      expect((await onboardingVerifyLimiter.enforce('test-ip-onboard-verify')).ok).toBe(true);
    }
    expect((await onboardingVerifyLimiter.enforce('test-ip-onboard-verify')).ok).toBe(false);
    onboardingVerifyLimiter.reset();
  });

  it('exports onboardingConsumeLimiter avec capacity 10/min (bcrypt + provisioning)', async () => {
    const { onboardingConsumeLimiter } = await import('@/lib/auth/rate-limit');
    onboardingConsumeLimiter.reset();
    for (let i = 0; i < 10; i++) {
      expect((await onboardingConsumeLimiter.enforce('test-ip-onboard-consume')).ok).toBe(true);
    }
    expect((await onboardingConsumeLimiter.enforce('test-ip-onboard-consume')).ok).toBe(false);
    expect((await onboardingConsumeLimiter.enforce('other-ip-onboard-consume')).ok).toBe(true);
    onboardingConsumeLimiter.reset();
  });

  const plafond = async (nom: 'renouvellementIpLimiter' | 'renouvellementLienLimiter', n: number) => {
    const l = (await import('@/lib/auth/rate-limit'))[nom];
    l.reset();
    for (let i = 0; i < n; i++) expect((await l.enforce('k')).ok).toBe(true);
    expect([(await l.enforce('k')).ok, (await l.enforce('autre')).ok]).toEqual([false, true]);
    l.reset();
  };
  it('exports renouvellementIpLimiter : 5 envois, puis refus', async () => plafond('renouvellementIpLimiter', 5));
  it('exports renouvellementLienLimiter : 2 envois par lien, puis refus', async () => plafond('renouvellementLienLimiter', 2));

  it('exports onboardingQualificationLimiter avec capacity 60/min par userId:IP', async () => {
    const { onboardingQualificationLimiter } = await import('@/lib/auth/rate-limit');
    onboardingQualificationLimiter.reset();
    const key = 'user_1:203.0.113.50';
    for (let i = 0; i < 60; i++) {
      expect((await onboardingQualificationLimiter.enforce(key)).ok).toBe(true);
    }
    expect((await onboardingQualificationLimiter.enforce(key)).ok).toBe(false);
    expect((await onboardingQualificationLimiter.enforce('user_2:203.0.113.50')).ok).toBe(true);
    expect((await onboardingQualificationLimiter.enforce('user_1:203.0.113.51')).ok).toBe(true);
    onboardingQualificationLimiter.reset();
  });

  it('exports billingStatePollLimiter avec capacity 60/min (POLL billing-state par secret)', async () => {
    // Limiter introduit par l'agent billing (commit 49b18e8) pour
    // GET /api/tenants/[tenantId]/billing-state — réconciliation §6.3.
    // Couvert ici car la règle 1-pour-1 du scanner exige un test() par
    // nouvel export public et le contrat de cap par secret doit rester
    // stable (un changement non-intentionnel = breaking pour les cron
    // downstream qui poll cet endpoint).
    const { billingStatePollLimiter } = await import('@/lib/auth/rate-limit');
    billingStatePollLimiter.reset();
    for (let i = 0; i < 60; i++) {
      expect((await billingStatePollLimiter.enforce('app:notifuse')).ok).toBe(true);
    }
    expect((await billingStatePollLimiter.enforce('app:notifuse')).ok).toBe(false);
    // Isolation par clé : une autre app/secret n'est pas affectée.
    expect((await billingStatePollLimiter.enforce('app:prospection')).ok).toBe(true);
    billingStatePollLimiter.reset();
  });

  it('exports discoveryPreVerifyLimiter avec capacity 60/min (anti-flood pré-HMAC discovery)', async () => {
    const { discoveryPreVerifyLimiter } = await import('@/lib/auth/rate-limit');
    discoveryPreVerifyLimiter.reset();
    for (let i = 0; i < 60; i++) {
      expect((await discoveryPreVerifyLimiter.enforce('test-ip-disc-pre')).ok).toBe(true);
    }
    expect((await discoveryPreVerifyLimiter.enforce('test-ip-disc-pre')).ok).toBe(false);
    discoveryPreVerifyLimiter.reset();
  });

  it('exports discoveryAppLimiter avec capacity 30/min (plafond par secret HMAC discovery)', async () => {
    const { discoveryAppLimiter } = await import('@/lib/auth/rate-limit');
    discoveryAppLimiter.reset();
    // Clé = nom d'app (après vérif HMAC) — pas IP. Isolation par secret.
    for (let i = 0; i < 30; i++) {
      expect((await discoveryAppLimiter.enforce('notifuse')).ok).toBe(true);
    }
    expect((await discoveryAppLimiter.enforce('notifuse')).ok).toBe(false);
    // Une autre app n'est pas affectée par l'épuisement de notifuse.
    expect((await discoveryAppLimiter.enforce('prospection')).ok).toBe(true);
    discoveryAppLimiter.reset();
  });

  it('exports mailSendAsUserPreVerifyLimiter avec capacity 60/min (anti-flood IP avant HMAC)', async () => {
    const { mailSendAsUserPreVerifyLimiter } = await import('@/lib/auth/rate-limit');
    mailSendAsUserPreVerifyLimiter.reset();
    // Clé = IP, plafond généreux pour ne pas bloquer un batch normal.
    for (let i = 0; i < 60; i++) {
      expect((await mailSendAsUserPreVerifyLimiter.enforce('203.0.113.1')).ok).toBe(true);
    }
    expect((await mailSendAsUserPreVerifyLimiter.enforce('203.0.113.1')).ok).toBe(false);
    // Autre IP non affectée.
    expect((await mailSendAsUserPreVerifyLimiter.enforce('203.0.113.2')).ok).toBe(true);
    mailSendAsUserPreVerifyLimiter.reset();
  });

  it('exports mailSendAsUserLimiter avec capacity 5/min/(app:user) (préserve quota Gmail)', async () => {
    const { mailSendAsUserLimiter } = await import('@/lib/auth/rate-limit');
    mailSendAsUserLimiter.reset();
    // Cap strict : Gmail standard = 250 mails/jour/user. 5/min permet
    // ~300/heure si batch continu — l'app downstream doit étaler les bursts.
    const key = 'prospection:cuid_user_alice';
    for (let i = 0; i < 5; i++) {
      expect((await mailSendAsUserLimiter.enforce(key)).ok).toBe(true);
    }
    expect((await mailSendAsUserLimiter.enforce(key)).ok).toBe(false);

    // Isolation par (app, user) : un autre user de la même app n'est pas affecté.
    expect((await mailSendAsUserLimiter.enforce('prospection:cuid_other')).ok).toBe(true);
    // Même user, autre app : également isolé (clé composite).
    expect((await mailSendAsUserLimiter.enforce('notifuse:cuid_user_alice')).ok).toBe(true);
    mailSendAsUserLimiter.reset();
  });
});

describe('shouldBypassRateLimit (E2E staging bypass)', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;

  // Secret long ≥ 32 chars utilisé dans la majorité des cas.
  const GOOD_SECRET = 'a'.repeat(64);

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = GOOD_SECRET;
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
  });

  const make = (headers: Record<string, string>) => new Headers(headers);

  it('retourne true quand DEPLOY_ENV=staging + secret valide + header présent', async () => {
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(true);
  });

  it('retourne true quand DEPLOY_ENV=local + secret valide + header présent', async () => {
    process.env.DEPLOY_ENV = 'local';
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(true);
  });

  it('retourne true quand DEPLOY_ENV unset (≠ prod) + secret valide + header présent', async () => {
    delete process.env.DEPLOY_ENV;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(true);
  });

  it('GARDE-FOU PROD : retourne false en prod même avec header secret valide', async () => {
    // C'est LE check le plus critique. Le header doit être ignoré en prod
    // peu importe sa valeur, sinon n'importe qui ayant le secret bypass
    // tout le rate-limit admin de prod.
    process.env.DEPLOY_ENV = 'prod';
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(false);
  });

  it('retourne false en prod même si secret undefined / longueur null', async () => {
    process.env.DEPLOY_ENV = 'prod';
    delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': 'whatever' })
      )
    ).toBe(false);
  });

  it('retourne false quand le header est absent', async () => {
    expect(shouldBypassRateLimit(make({}))).toBe(false);
  });

  it('retourne false quand le header secret est wrong (même longueur)', async () => {
    // Même longueur que GOOD_SECRET → on tape timingSafeEqual qui doit
    // renvoyer false sans throw.
    const wrong = 'b'.repeat(64);
    expect(
      shouldBypassRateLimit(make({ 'x-veridian-e2e-bypass-ratelimit': wrong }))
    ).toBe(false);
  });

  it('retourne false quand le header secret est wrong (longueur différente)', async () => {
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': 'too-short' })
      )
    ).toBe(false);
  });

  it("retourne false quand le secret env n'est pas configuré", async () => {
    delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(false);
  });

  it("retourne false quand le secret env est vide ('')", async () => {
    process.env.E2E_RATELIMIT_BYPASS_SECRET = '';
    expect(
      shouldBypassRateLimit(make({ 'x-veridian-e2e-bypass-ratelimit': '' }))
    ).toBe(false);
  });

  it('refuse un secret trop court (< 32 chars) même si match exact', async () => {
    // Garde-fou n°2 : on impose ≥ 32 chars pour qu'un opérateur ne pose
    // pas un "secret" trivial type "test" ou "1234".
    const short = 'a'.repeat(31);
    process.env.E2E_RATELIMIT_BYPASS_SECRET = short;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': short })
      )
    ).toBe(false);
  });

  it('accepte un secret pile à 32 chars (borne basse incluse)', async () => {
    const justEnough = 'a'.repeat(32);
    process.env.E2E_RATELIMIT_BYPASS_SECRET = justEnough;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': justEnough })
      )
    ).toBe(true);
  });
});

// ─── RateLimiter.enforceWithBypass : wrapper qui intègre bypass header ───
//
// Méthode introduite 2026-05-23 (ticket E2E fix signup) pour éviter de
// dupliquer le check `shouldBypassRateLimit` + `enforce` dans 8+ callers
// (signup, [...nextauth], invitations, discovery, billing-state, admin
// authenticate). Chaque caller appelle maintenant `enforceWithBypass(ip, headers)`
// et le check bypass est centralisé.
//
// Garde-fou critique : en prod (DEPLOY_ENV === 'prod'), le bypass DOIT être
// court-circuité — même avec header secret valide, le comportement doit
// rester strictement identique à `enforce(ip)` legacy. C'est testé pour
// chaque limiter exporté ET pour la méthode générique.

describe('RateLimiter.enforceWithBypass', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  const GOOD_SECRET = 'k'.repeat(48);

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = GOOD_SECRET;
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
  });

  const make = (headers: Record<string, string>) => new Headers(headers);

  it('bypass valide : 100 hits passent OK, jamais 429, bypassed=true', async () => {
    const rl = new RateLimiter({ capacity: 3, windowMs: 1000, name: 'test-bypass' });
    const headers = make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET });
    for (let i = 0; i < 100; i++) {
      const r = (await rl.enforceWithBypass('ip-flood', headers)) as any;
      expect(r.ok).toBe(true);
      expect(r.bypassed).toBe(true);
    }
    // Le storage interne n'est PAS incrémenté quand bypass = aucune trace IP.
    expect((await rl.depasse('ip-flood', Date.now())).ok).toBe(true);
  });

  it('sans header bypass : comportement identique à enforce()', async () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'test' });
    const headers = make({});
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(true);
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(true);
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(false);
  });

  it('GARDE-FOU PROD : bypass header ignoré, 429 au-delà du cap', async () => {
    process.env.DEPLOY_ENV = 'prod';
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'prod-rl' });
    const headers = make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET });
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(true);
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(true);
    const blocked = (await rl.enforceWithBypass('ip1', headers));
    expect(blocked.ok, 'PROD MUST ignore bypass header').toBe(false);
  });

  it('header secret wrong : bypass refusé, comportement enforce() normal', async () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'wrong-key' });
    const wrong = 'x'.repeat(48); // même longueur mais mauvais
    const headers = make({ 'x-veridian-e2e-bypass-ratelimit': wrong });
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(true);
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(true);
    expect((await rl.enforceWithBypass('ip1', headers)).ok).toBe(false);
  });

  // Pour chaque limiter exporté qui est consommé en E2E, on assert
  // explicitement que le bypass marche en staging ET échoue en prod.
  // C'est la matrice de régression : si demain quelqu'un swap `enforceWithBypass`
  // pour `enforce` sans bypass dans un caller, on perd cette anti-cascade.

  describe('matrice bypass × prod-safety par limiter exporté', () => {
    const limiters = [
      'adminApiLimiter',
      'signupLimiter',
      'credentialsLoginLimiter',
      'oauthStartLimiter',
      'oauthCallbackLimiter',
      'invitationCreateLimiter',
      'invitationVerifyLimiter',
      'onboardingVerifyLimiter',
      'onboardingConsumeLimiter',
      'onboardingQualificationLimiter',
      'renouvellementIpLimiter',
      'renouvellementLienLimiter',
      'discoveryPreVerifyLimiter',
      'discoveryAppLimiter',
      'billingStatePollLimiter',
    ] as const;

    for (const name of limiters) {
      it(`${name} : bypass actif en staging → traverse au-delà du cap`, async () => {
        const mod = await import('@/lib/auth/rate-limit');
        const limiter = (mod as any)[name] as RateLimiter;
        limiter.reset();
        const headers = make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET });
        // Hits = cap * 3 — sans bypass, on serait à 429 depuis longtemps.
        for (let i = 0; i < 200; i++) {
          const r = (await limiter.enforceWithBypass(`key-${name}`, headers));
          expect(r.ok, `${name} bypass hit #${i} failed`).toBe(true);
        }
        limiter.reset();
      });

      it(`${name} : GARDE-FOU PROD → bypass ignoré, 429 quand cap dépassé`, async () => {
        process.env.DEPLOY_ENV = 'prod';
        const mod = await import('@/lib/auth/rate-limit');
        const limiter = (mod as any)[name] as RateLimiter;
        limiter.reset();
        const headers = make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET });
        // On dépasse le cap. Récupère la capacité depuis les options privées
        // via une heuristique : on hit 200 fois et on attend ≥1 refus.
        let refused = false;
        for (let i = 0; i < 200; i++) {
          const r = (await limiter.enforceWithBypass(`prod-key-${name}`, headers));
          if (!r.ok) {
            refused = true;
            break;
          }
        }
        expect(refused, `${name} PROD doit refuser au-delà du cap, bypass ignoré`).toBe(true);
        limiter.reset();
      });
    }
  });
});

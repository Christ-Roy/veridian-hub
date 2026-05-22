/**
 * Tests unitaires de `lib/auth/google-one-tap-provider.ts`.
 *
 * Couvre :
 *  - Le garde-fou env (`isGoogleOneTapEnabled`) : actif hors staging avec
 *    client_id, inactif sinon.
 *  - `authorize()` : validation du id_token, retrouve/crée le user, patch
 *    `supabaseUserId` (Auth.js NE déclenche PAS `createUser` pour les
 *    providers Credentials — même piège que mock-oauth-provider), création
 *    de la row Account, provisioning workspace au premier login.
 *  - Les rejets : token invalide, email non vérifié, env non autorisé.
 *
 * Le vérificateur de token est injecté (`verifyToken`) pour éviter tout
 * appel réseau aux JWKS Google.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, type KeyObject } from 'jose';
import {
  buildGoogleOneTapProvider,
  isGoogleOneTapEnabled,
  resolveGoogleClientId,
  verifyGoogleIdToken,
  type GoogleOneTapDeps,
} from '@/lib/auth/google-one-tap-provider';

const CLIENT_ID = '123456789-abc.apps.googleusercontent.com';

/**
 * Provider Credentials Auth.js — l'`authorize` original (celui qu'on passe
 * à `Credentials({...})`) est conservé dans `.options.authorize`. Le champ
 * `.authorize` de premier niveau est un wrapper interne Auth.js.
 */
type ProviderLike = {
  options: {
    authorize: (credentials: unknown) => Promise<{ id: string; email: string } | null>;
  };
};

/** Récupère la fonction `authorize` réelle d'un provider Credentials. */
function authorizeOf(provider: unknown): ProviderLike['options']['authorize'] {
  return (provider as ProviderLike).options.authorize;
}

/** Claims Google valides par défaut. */
function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'google-sub-001',
    email: 'visitor@gmail.com',
    email_verified: true,
    name: 'Visitor One',
    picture: 'https://lh3.googleusercontent.com/a/pic',
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    ...overrides,
  };
}

function makeDeps(opts: {
  existingUser?: { id: string; email: string; name: string | null; image: string | null; supabaseUserId: string | null } | null;
  existingAccount?: { id: string } | null;
  verifyThrows?: string;
  verifyClaims?: Record<string, unknown>;
  provisionThrows?: boolean;
  fixedUuid?: string;
} = {}): GoogleOneTapDeps & {
  _userCreate: ReturnType<typeof vi.fn>;
  _userUpdate: ReturnType<typeof vi.fn>;
  _accountCreate: ReturnType<typeof vi.fn>;
  _provision: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
} {
  const userFindUnique = vi.fn(async () =>
    opts.existingUser === undefined ? null : opts.existingUser,
  );
  const userCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-user-1',
    email: data.email,
    name: data.name ?? null,
    image: data.image ?? null,
    supabaseUserId: data.supabaseUserId ?? null,
  }));
  const userUpdate = vi.fn(async () => ({ id: 'u1' }));
  const accountFindUnique = vi.fn(async () =>
    opts.existingAccount === undefined ? null : opts.existingAccount,
  );
  const accountCreate = vi.fn(async () => ({ id: 'acc-1' }));
  const provision = vi.fn(async () => {
    if (opts.provisionThrows) throw new Error('workspace provision failed');
    return { workspaceId: 'ws-1', created: true, workspaceName: 'default' };
  });
  const verifyToken = vi.fn(async () => {
    if (opts.verifyThrows) throw new Error(opts.verifyThrows);
    return { ...validClaims(opts.verifyClaims) } as never;
  });
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

  return {
    prisma: {
      user: { findUnique: userFindUnique, create: userCreate, update: userUpdate },
      account: { findUnique: accountFindUnique, create: accountCreate },
    } as never,
    logger,
    generateUuid: vi.fn(() => opts.fixedUuid ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    verifyToken: verifyToken as never,
    provisionWorkspace: provision as never,
    _userCreate: userCreate,
    _userUpdate: userUpdate,
    _accountCreate: accountCreate,
    _provision: provision,
  };
}

describe('isGoogleOneTapEnabled / resolveGoogleClientId', () => {
  it('actif quand DEPLOY_ENV != staging et client_id présent', () => {
    expect(isGoogleOneTapEnabled({ DEPLOY_ENV: 'prod', GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID } as never)).toBe(true);
  });

  it('inactif en staging même avec client_id', () => {
    expect(
      isGoogleOneTapEnabled({ DEPLOY_ENV: 'staging', GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID } as never),
    ).toBe(false);
  });

  it('inactif si client_id absent', () => {
    expect(isGoogleOneTapEnabled({ DEPLOY_ENV: 'prod' } as never)).toBe(false);
  });

  it('resolveGoogleClientId renvoie undefined si vide', () => {
    expect(resolveGoogleClientId({ GOOGLE_OAUTH_CLIENT_ID: '' } as never)).toBeUndefined();
  });
});

describe('buildGoogleOneTapProvider — garde-fou env', () => {
  const realEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...realEnv };
  });

  it('renvoie null en staging', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    expect(buildGoogleOneTapProvider(makeDeps())).toBeNull();
  });

  it('renvoie null sans client_id', () => {
    process.env.DEPLOY_ENV = 'prod';
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(buildGoogleOneTapProvider(makeDeps())).toBeNull();
  });

  it('renvoie un provider hors staging avec client_id', () => {
    process.env.DEPLOY_ENV = 'prod';
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
    expect(buildGoogleOneTapProvider(makeDeps())).not.toBeNull();
  });
});

describe('google-one-tap authorize()', () => {
  const realEnv = { ...process.env };

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'prod';
    process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
  });
  afterEach(() => {
    process.env = { ...realEnv };
  });

  it('signup : crée le user avec supabaseUserId UUID v4 + workspace + Account', async () => {
    const deps = makeDeps({ existingUser: null, existingAccount: null, fixedUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    const result = await authorize({ credential: 'fake.jwt.token' });

    // User créé avec le pont supabaseUserId (sinon Dashboard crash).
    expect(deps._userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'visitor@gmail.com',
          supabaseUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
      }),
    );
    // Account provider=google créé (account linking).
    expect(deps._accountCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: 'google', providerAccountId: 'google-sub-001' }),
      }),
    );
    // Workspace provisionné au premier login.
    expect(deps._provision).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ id: 'new-user-1', email: 'visitor@gmail.com' }));
  });

  it('login user existant : pas de create user, pas de provision workspace', async () => {
    const deps = makeDeps({
      existingUser: { id: 'u9', email: 'visitor@gmail.com', name: 'V', image: null, supabaseUserId: 'existing-uuid' },
      existingAccount: { id: 'acc-x' },
    });
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    const result = await authorize({ credential: 'fake.jwt.token' });

    expect(deps._userCreate).not.toHaveBeenCalled();
    expect(deps._userUpdate).not.toHaveBeenCalled();
    expect(deps._provision).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ id: 'u9' }));
  });

  it('user existant sans supabaseUserId : backfill du pont UUID', async () => {
    const deps = makeDeps({
      existingUser: { id: 'u-legacy', email: 'visitor@gmail.com', name: null, image: null, supabaseUserId: null },
      existingAccount: { id: 'acc-x' },
      fixedUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    await authorize({ credential: 'fake.jwt.token' });

    expect(deps._userUpdate).toHaveBeenCalledWith({
      where: { id: 'u-legacy' },
      data: { supabaseUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    });
  });

  it('token invalide → refuse (return null), ne crée rien', async () => {
    const deps = makeDeps({ verifyThrows: 'signature invalide' });
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    const result = await authorize({ credential: 'tampered.jwt' });

    expect(result).toBeNull();
    expect(deps._userCreate).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('credential manquant → refuse sans valider', async () => {
    const deps = makeDeps();
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    expect(await authorize({})).toBeNull();
    expect(await authorize({ credential: '' })).toBeNull();
  });

  it('échec provisioning workspace : ne bloque pas le signup', async () => {
    const deps = makeDeps({ existingUser: null, existingAccount: null, provisionThrows: true });
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    const result = await authorize({ credential: 'fake.jwt.token' });

    // Signup réussit malgré l'échec workspace ; l'erreur est loggée.
    expect(result).toEqual(expect.objectContaining({ id: 'new-user-1' }));
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('Account déjà existant : pas de double création', async () => {
    const deps = makeDeps({
      existingUser: { id: 'u9', email: 'visitor@gmail.com', name: 'V', image: null, supabaseUserId: 'x' },
      existingAccount: { id: 'acc-existing' },
    });
    const authorize = authorizeOf(buildGoogleOneTapProvider(deps));

    await authorize({ credential: 'fake.jwt.token' });

    expect(deps._accountCreate).not.toHaveBeenCalled();
  });
});

/**
 * Validation cryptographique réelle de `verifyGoogleIdToken` — on signe des
 * id_token avec une paire de clés RS256 locale (jose), et on injecte la clé
 * publique comme `keySet` pour éviter tout appel réseau aux JWKS Google.
 */
describe('verifyGoogleIdToken — validation crypto', () => {
  let privateKey: KeyObject;
  let publicKey: KeyObject;

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey as KeyObject;
    publicKey = pair.publicKey as KeyObject;
  });

  /** Forge un id_token Google signé localement. */
  async function sign(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(opts.iss ?? 'https://accounts.google.com')
      .setAudience(opts.aud ?? CLIENT_ID)
      .setExpirationTime(opts.exp ?? '1h')
      .sign(privateKey);
  }

  it('token valide → renvoie les claims', async () => {
    const token = await sign({ email: 'ok@gmail.com', email_verified: true, sub: 's1' });
    const claims = await verifyGoogleIdToken(token, CLIENT_ID, publicKey);
    expect(claims.email).toBe('ok@gmail.com');
    expect(claims.sub).toBe('s1');
  });

  it('audience qui ne matche pas le client_id → rejet', async () => {
    const token = await sign({ email: 'ok@gmail.com', email_verified: true }, { aud: 'autre-client' });
    await expect(verifyGoogleIdToken(token, CLIENT_ID, publicKey)).rejects.toThrow();
  });

  it('issuer non-Google → rejet', async () => {
    const token = await sign({ email: 'ok@gmail.com', email_verified: true }, { iss: 'https://evil.example.com' });
    await expect(verifyGoogleIdToken(token, CLIENT_ID, publicKey)).rejects.toThrow();
  });

  it('token expiré → rejet', async () => {
    const token = await sign({ email: 'ok@gmail.com', email_verified: true }, { exp: '-1h' });
    await expect(verifyGoogleIdToken(token, CLIENT_ID, publicKey)).rejects.toThrow();
  });

  it('email non vérifié → rejet', async () => {
    const token = await sign({ email: 'unverified@gmail.com', email_verified: false });
    await expect(verifyGoogleIdToken(token, CLIENT_ID, publicKey)).rejects.toThrow(/non vérifié/);
  });

  it('email_verified en string "true" accepté (tolérance Google)', async () => {
    const token = await sign({ email: 'ok@gmail.com', email_verified: 'true' });
    const claims = await verifyGoogleIdToken(token, CLIENT_ID, publicKey);
    expect(claims.email).toBe('ok@gmail.com');
  });

  it('token sans email → rejet', async () => {
    const token = await sign({ email_verified: true });
    await expect(verifyGoogleIdToken(token, CLIENT_ID, publicKey)).rejects.toThrow(/sans email/);
  });

  it('signature avec une autre clé → rejet', async () => {
    const otherPair = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: 'ok@gmail.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setExpirationTime('1h')
      .sign(otherPair.privateKey);
    await expect(verifyGoogleIdToken(token, CLIENT_ID, publicKey)).rejects.toThrow();
  });
});

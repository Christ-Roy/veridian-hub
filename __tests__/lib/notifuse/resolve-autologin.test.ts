/**
 * Tests de `resolveNotifuseAutoLogin` — cœur du fix autologin cross-app
 * (`todo/2026-07-06-autologin-cross-app-casse.md`).
 *
 * Le comportement à verrouiller : un tenant rattaché par `hub link`, donc SANS
 * `notifuseApiKey` ni `notifuseUserEmail`, doit quand même obtenir une URL
 * d'auto-login — via `getHealth` (owner réel) puis `provisionWorkspace`
 * idempotent. Avant ce fix, la route répondait 409 et le client atterrissait
 * sur l'écran de login Notifuse.
 *
 * Les valeurs de retour de Notifuse reproduites ici ont été vérifiées contre
 * `notifuse.staging.veridian.site` le 2026-07-28 : sur un workspace existant,
 * `provisionWorkspace` renvoie `created: false`, `api_key: ""` (vide) et un
 * `auto_login_url` valide.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { resolveNotifuseAutoLogin } from '@/lib/notifuse/resolve-autologin';
import { NotifuseError } from '@/lib/notifuse/types';

const AUTO_LOGIN = 'https://notifuse.test/veridian/auto-login?token=abc';

const generateMagicLink = vi.fn();
const getHealth = vi.fn();
const provisionWorkspace = vi.fn();
const tenantUpdate = vi.fn();

const silentLogger = { error: vi.fn(), info: vi.fn() };

function deps() {
  return {
    prisma: { tenant: { update: tenantUpdate } } as never,
    client: { generateMagicLink, getHealth, provisionWorkspace },
    logger: silentLogger,
  };
}

/** Tenant rattaché par `hub link` : slug seul, aucun credential. */
const linkedTenant = {
  id: 'tenant-1',
  notifuseWorkspaceSlug: 'celinegaetan',
  notifuseApiKey: null,
  notifuseUserEmail: null,
};

/** Tenant provisionné par le Hub : credentials complets. */
const provisionedTenant = {
  id: 'tenant-2',
  notifuseWorkspaceSlug: 'acme',
  notifuseApiKey: 'key-123',
  notifuseUserEmail: 'owner@acme.test',
};

const healthyResponse = {
  tenant_id: 'celinegaetan',
  workspace_id: 'celinegaetan',
  status: 'active' as const,
  owner_attached: true,
  owner_email: 'celine@cesaretbrutus.test',
  owner_user_id: 'u-1',
  api_key_valid: true,
  magic_link_capable: true,
  members_count: 2,
  plan: 'free' as const,
  checked_at: '2026-07-28T10:00:00Z',
};

beforeEach(() => {
  generateMagicLink.mockReset();
  getHealth.mockReset();
  provisionWorkspace.mockReset();
  tenantUpdate.mockReset();
  silentLogger.error.mockReset();
  silentLogger.info.mockReset();
  tenantUpdate.mockResolvedValue({});
});

describe('chemin nominal (clé API tenant présente)', () => {
  it('utilise generateMagicLink et ne touche pas au chemin HMAC', async () => {
    generateMagicLink.mockResolvedValue({
      auto_login_url: AUTO_LOGIN,
      magic_link: 'https://notifuse.test/console/signin?code=1',
      expires_at: '2026-07-28T11:00:00Z',
    });

    const result = await resolveNotifuseAutoLogin(provisionedTenant, deps());

    expect(result).toMatchObject({ ok: true, autoLoginUrl: AUTO_LOGIN, source: 'api_key' });
    expect(generateMagicLink).toHaveBeenCalledWith({
      apiKey: 'key-123',
      userEmail: 'owner@acme.test',
    });
    expect(getHealth).not.toHaveBeenCalled();
    expect(provisionWorkspace).not.toHaveBeenCalled();
    expect(tenantUpdate).not.toHaveBeenCalled();
  });

  it('bascule sur le chemin HMAC quand la clé API est révoquée', async () => {
    // Désync Hub↔Notifuse : la clé stockée ne vaut plus rien. On ne doit PAS
    // rendre une erreur au client tant que la réparation est possible.
    generateMagicLink.mockRejectedValue(new NotifuseError('unauthorized', 401, null));
    getHealth.mockResolvedValue({ ...healthyResponse, workspace_id: 'acme' });
    provisionWorkspace.mockResolvedValue({ created: false, api_key: '', auto_login_url: AUTO_LOGIN });

    const result = await resolveNotifuseAutoLogin(provisionedTenant, deps());

    expect(result).toMatchObject({ ok: true, source: 'provision_idempotent' });
    expect(provisionWorkspace).toHaveBeenCalled();
  });
});

describe('chemin de réparation (tenant rattaché par hub link)', () => {
  it("produit une URL d'auto-login sans jamais posséder la clé API", async () => {
    getHealth.mockResolvedValue(healthyResponse);
    provisionWorkspace.mockResolvedValue({
      created: false,
      api_key: '', // Notifuse ne renvoie pas la clé sur un workspace existant
      auto_login_url: AUTO_LOGIN,
      magic_link: 'https://notifuse.test/console/signin?code=2',
    });

    const result = await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(result).toMatchObject({
      ok: true,
      autoLoginUrl: AUTO_LOGIN,
      source: 'provision_idempotent',
    });
    expect(generateMagicLink).not.toHaveBeenCalled();
  });

  it("provisionne avec l'owner RÉEL de Notifuse, pas l'email stocké côté Hub", async () => {
    // Point de contrat vérifié sur staging : provision avec un owner_email
    // divergent répond 409. `getHealth` est donc la seule source de vérité.
    getHealth.mockResolvedValue({ ...healthyResponse, owner_email: 'vrai-owner@x.test' });
    provisionWorkspace.mockResolvedValue({ created: false, api_key: '', auto_login_url: AUTO_LOGIN });

    await resolveNotifuseAutoLogin(
      { ...linkedTenant, notifuseUserEmail: 'perime@x.test' },
      deps(),
    );

    expect(provisionWorkspace).toHaveBeenCalledWith({
      tenantId: 'celinegaetan',
      ownerEmail: 'vrai-owner@x.test',
    });
  });

  it("backfille l'email owner pour que le clic suivant prenne le chemin rapide", async () => {
    getHealth.mockResolvedValue(healthyResponse);
    provisionWorkspace.mockResolvedValue({ created: false, api_key: '', auto_login_url: AUTO_LOGIN });

    const result = await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(result).toMatchObject({ ok: true, backfilled: true });
    expect(tenantUpdate).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { notifuseUserEmail: 'celine@cesaretbrutus.test' },
    });
  });

  it('ne persiste jamais une api_key vide', async () => {
    getHealth.mockResolvedValue({ ...healthyResponse, owner_email: null });
    provisionWorkspace.mockResolvedValue({ created: false, api_key: '', auto_login_url: AUTO_LOGIN });

    await resolveNotifuseAutoLogin(
      { ...linkedTenant, notifuseUserEmail: 'deja@bon.test' },
      deps(),
    );

    expect(tenantUpdate).not.toHaveBeenCalled();
  });

  it('persiste la clé API quand Notifuse en renvoie une', async () => {
    getHealth.mockResolvedValue(healthyResponse);
    provisionWorkspace.mockResolvedValue({
      created: true,
      api_key: 'fresh-key',
      auto_login_url: AUTO_LOGIN,
    });

    await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(tenantUpdate).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: {
        notifuseUserEmail: 'celine@cesaretbrutus.test',
        notifuseApiKey: 'fresh-key',
      },
    });
  });

  it("rend quand même le lien si le backfill échoue (jamais bloquant)", async () => {
    getHealth.mockResolvedValue(healthyResponse);
    provisionWorkspace.mockResolvedValue({ created: false, api_key: '', auto_login_url: AUTO_LOGIN });
    tenantUpdate.mockRejectedValue(new Error('DB down'));

    const result = await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(result).toMatchObject({ ok: true, autoLoginUrl: AUTO_LOGIN, backfilled: false });
  });
});

describe('échecs explicites', () => {
  it('refuse un tenant sans workspace rattaché', async () => {
    const result = await resolveNotifuseAutoLogin(
      { ...linkedTenant, notifuseWorkspaceSlug: null },
      deps(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'not_linked', status: 409 });
    expect(getHealth).not.toHaveBeenCalled();
  });

  it('refuse un slug qui ne peut pas être un workspace_id Notifuse', async () => {
    // `link-app` acceptait des slugs à hyphens / > 20 chars, impossibles
    // côté Notifuse. On échoue lisiblement au lieu d'un 404 opaque.
    const result = await resolveNotifuseAutoLogin(
      { ...linkedTenant, notifuseWorkspaceSlug: 'cesar-et-brutus-workspace-trop-long' },
      deps(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid_workspace_id', status: 409 });
    expect(getHealth).not.toHaveBeenCalled();
  });

  it('signale un workspace inconnu de Notifuse', async () => {
    getHealth.mockRejectedValue(new NotifuseError('tenant not found', 404, null));

    const result = await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(result).toMatchObject({ ok: false, reason: 'workspace_not_found', status: 409 });
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });

  it("n'appelle pas provision quand le workspace n'est pas magic-link capable", async () => {
    getHealth.mockResolvedValue({
      ...healthyResponse,
      owner_attached: false,
      magic_link_capable: false,
    });

    const result = await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(result).toMatchObject({ ok: false, reason: 'not_magic_link_capable', status: 409 });
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });

  it('propage une erreur downstream en 502', async () => {
    getHealth.mockResolvedValue(healthyResponse);
    provisionWorkspace.mockRejectedValue(new Error('network'));

    const result = await resolveNotifuseAutoLogin(linkedTenant, deps());

    expect(result).toMatchObject({ ok: false, reason: 'downstream_error', status: 502 });
  });
});

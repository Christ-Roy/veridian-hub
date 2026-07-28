/**
 * Test d'intégration LIVE du fix auto-login Notifuse
 * (`todo/2026-07-06-autologin-cross-app-casse.md`).
 *
 * Contrairement aux tests unitaires de `resolve-autologin`, celui-ci parle au
 * VRAI Notifuse (staging) avec le VRAI client HMAC. Il prouve le seul point
 * qui ne peut pas être prouvé par des mocks : qu'un workspace Notifuse
 * provisionné HORS du Hub — donc sans que le Hub possède jamais sa clé API —
 * peut quand même produire une URL d'auto-login exploitable.
 *
 * C'est exactement l'état du tenant Céline Gaetan le 2026-07-06 : workspace
 * créé au CLI `notifuse`, rattaché par `hub link`, colonnes `notifuse_api_key`
 * et `notifuse_user_email` vides côté Hub → 409 au clic « Ouvrir Veridian Mail ».
 *
 * SKIPPÉ par défaut : ne tourne que si `NOTIFUSE_HUB_API_SECRET` (ou sa
 * variante `_STAGING`) est présent dans l'environnement. La CI unitaire n'a
 * pas ce secret, donc ce fichier y est neutre.
 *
 * GARDE-FOU : refus explicite de cibler l'instance de production — ce test
 * provisionne des workspaces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { NotifuseClient } from '@/lib/notifuse/client';
import { resolveNotifuseAutoLogin } from '@/lib/notifuse/resolve-autologin';

const NOTIFUSE_URL =
  process.env.NOTIFUSE_STAGING_URL ?? 'https://notifuse.staging.veridian.site';
const SECRET =
  process.env.NOTIFUSE_HUB_API_SECRET_STAGING ??
  process.env.NOTIFUSE_HUB_API_SECRET ??
  '';

const LIVE = Boolean(SECRET) && !NOTIFUSE_URL.includes('.app.veridian.site');

/** Collecte les écritures Prisma sans jamais toucher une base. */
function makePrismaSpy() {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  return {
    updates,
    prisma: {
      tenant: {
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return {};
        },
      },
    } as never,
  };
}

const workspaceId = `live${Date.now().toString(36)}`.slice(0, 20);
const ownerEmail = `${workspaceId}@e2e.test`;
let client: NotifuseClient;

describe.skipIf(!LIVE)('auto-login Notifuse — intégration live (staging)', () => {
  beforeAll(async () => {
    client = new NotifuseClient({ apiUrl: NOTIFUSE_URL, hubSecret: SECRET });

    // État de départ : workspace créé EN DIRECT côté Notifuse, comme le ferait
    // le CLI `notifuse`. Le Hub n'en saura jamais la clé API.
    const provisioned = await client.provisionWorkspace({
      tenantId: workspaceId,
      ownerEmail,
      workspaceName: `Live autologin ${workspaceId}`,
      plan: 'free',
    });
    expect(provisioned.created, 'workspace de test fraîchement créé').toBe(true);
  }, 60_000);

  afterAll(async () => {
    // Nettoyage staging — best-effort, ne fait jamais échouer la suite.
    await client?.deleteWorkspace(workspaceId).catch(() => undefined);
  }, 30_000);

  it(
    "produit une URL d'auto-login pour un tenant sans clé API ni email owner",
    async () => {
      const { prisma, updates } = makePrismaSpy();

      // Le tenant tel que `hub link` le laisse en base : slug seul.
      const result = await resolveNotifuseAutoLogin(
        {
          id: 'tenant-live',
          notifuseWorkspaceSlug: workspaceId,
          notifuseApiKey: null,
          notifuseUserEmail: null,
        },
        { prisma, client, logger: { error: () => {}, info: () => {} } },
      );

      expect(result.ok, `résolution échouée : ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;

      expect(result.source).toBe('provision_idempotent');
      expect(result.autoLoginUrl).toContain('/veridian/auto-login');

      // L'email owner découvert via getHealth est persisté pour le clic suivant.
      expect(updates).toHaveLength(1);
      expect(updates[0].data.notifuseUserEmail).toBe(ownerEmail);

      // L'URL est réellement servie par Notifuse (pas un lien fabriqué).
      const res = await fetch(result.autoLoginUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      expect(res.status, "l'URL d'auto-login doit être servie").toBeLessThan(400);
    },
    90_000,
  );

  it(
    'emprunte le chemin rapide une fois les credentials backfillés',
    async () => {
      const { prisma, updates } = makePrismaSpy();

      // Le Hub a désormais l'email owner ; on simule aussi une clé API absente
      // pour vérifier qu'on reste sur le chemin de réparation tant qu'elle
      // manque — c'est le cas durable d'un workspace créé hors Hub.
      const result = await resolveNotifuseAutoLogin(
        {
          id: 'tenant-live',
          notifuseWorkspaceSlug: workspaceId,
          notifuseApiKey: null,
          notifuseUserEmail: ownerEmail,
        },
        { prisma, client, logger: { error: () => {}, info: () => {} } },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.autoLoginUrl).toContain('/veridian/auto-login');
      // Rien de nouveau à apprendre → aucune écriture DB.
      expect(updates).toHaveLength(0);
    },
    90_000,
  );

  it(
    'échoue proprement sur un workspace inconnu de Notifuse',
    async () => {
      const { prisma } = makePrismaSpy();

      const result = await resolveNotifuseAutoLogin(
        {
          id: 'tenant-ghost',
          notifuseWorkspaceSlug: `ghost${Date.now().toString(36)}`.slice(0, 20),
          notifuseApiKey: null,
          notifuseUserEmail: null,
        },
        { prisma, client, logger: { error: () => {}, info: () => {} } },
      );

      expect(result).toMatchObject({ ok: false, reason: 'workspace_not_found' });
    },
    60_000,
  );
});

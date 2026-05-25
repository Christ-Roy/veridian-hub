#!/usr/bin/env node
/**
 * Backfill Hub d'un tenant orphelin détecté côté app downstream.
 *
 * Cas d'usage (ticket todo/2026-05-25-tenant-drift-cross-app-detected.md) :
 *
 *   Un workspace existe côté app (ex Prospection
 *   `tenant_id=462a4295-…`) MAIS aucune row `hub_app.tenants` n'a cet `id`
 *   → la route `POST /api/billing/refill-leads/checkout` refuse 404 le
 *   tenantId (`tenant_not_found_or_forbidden`). Le user paye ailleurs, on
 *   le bloque sur le Hub.
 *
 * Stratégie :
 *
 *   1. Input minimal : (app, tenantId, ownerEmail)
 *   2. Vérifier que la row Hub n'existe vraiment pas (idempotence)
 *   3. Lookup user Hub via prisma.user.findUnique({ where: { email } })
 *   4. Si user existe : INSERT row Tenant
 *      - `id` = tenantId fourni (alignement 1:1 cross-app exigé v1.4)
 *      - `userId` = user.supabaseUserId (UUID bridge legacy)
 *      - `slug` = `backfill-${app}-${tenantId}` (slug technique unique)
 *      - `status` = 'active'
 *      - `<app>Plan` = champ dédié si app=notifuse/prospection
 *      - `metadata.<app>` = payload audit (provisioning_source='backfill', ts)
 *   5. Si user n'existe pas : warn + skip (orphelin profond → arbitrage humain)
 *
 * Idempotent : si la row Tenant existe déjà (peu importe son state),
 * skip + log "already_backfilled". Pas d'UPDATE écrasant — on suppose
 * que la row existante est correcte ou qu'elle sera réconciliée par
 * d'autres canaux (webhook v1.4, sync push).
 *
 * Mode dry-run par défaut. `--execute` pour vraiment écrire. Robert
 * doit valider chaque execution write en prod (cf
 * `runbooks/services/hub/tenant-drift-recovery.md`).
 *
 * Usage :
 *
 *   # Dry-run (recommandé en premier)
 *   pnpm tsx scripts/admin/backfill-hub-tenant-from-app.ts \
 *     --app prospection \
 *     --tenant-id 462a4295-8e9b-4ef1-b107-7358f1739ba8 \
 *     --owner-email client@example.com
 *
 *   # Execute (réserve à Robert, après audit)
 *   pnpm tsx scripts/admin/backfill-hub-tenant-from-app.ts \
 *     --app prospection \
 *     --tenant-id 462a4295-8e9b-4ef1-b107-7358f1739ba8 \
 *     --owner-email client@example.com \
 *     --execute
 *
 * ENV requis :
 *   DATABASE_URL — Postgres veridian-core-db (schema hub_app)
 *
 * Sécurité :
 *   - Mode dry-run par défaut (oblige --execute explicite)
 *   - Skip auto si row Tenant existe déjà (idempotence)
 *   - Skip auto si user Hub introuvable (orphelin profond)
 *   - Pas de DELETE jamais
 *   - Audit log (console structuré) pour traçabilité
 */

import type { PrismaClient } from '@prisma/client';

export type BackfillApp = 'notifuse' | 'prospection' | 'analytics' | 'cms';

const VALID_APPS: readonly BackfillApp[] = [
  'notifuse',
  'prospection',
  'analytics',
  'cms',
] as const;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BackfillInput {
  app: BackfillApp;
  tenantId: string;
  ownerEmail: string;
}

export type BackfillOutcome =
  | { status: 'created'; tenantId: string; userUuid: string; userId: string }
  | { status: 'already_backfilled'; tenantId: string }
  | { status: 'user_not_found'; email: string }
  | { status: 'invalid_input'; reason: string };

/**
 * Cœur du script — testable en injectant Prisma mocké.
 *
 * @param prisma Client Prisma (réel ou mocké)
 * @param input Données du drift à backfill
 * @param execute Si false (défaut), no-op write — juste preview
 */
export async function backfillHubTenantFromApp(
  prisma: PrismaClient,
  input: BackfillInput,
  execute: boolean,
): Promise<BackfillOutcome> {
  // 1. Validation input
  if (!VALID_APPS.includes(input.app)) {
    return {
      status: 'invalid_input',
      reason: `unknown app: ${input.app} (must be one of ${VALID_APPS.join(',')})`,
    };
  }
  if (!UUID_REGEX.test(input.tenantId)) {
    return {
      status: 'invalid_input',
      reason: `invalid UUID tenantId: ${input.tenantId}`,
    };
  }
  if (!input.ownerEmail.includes('@')) {
    return {
      status: 'invalid_input',
      reason: `invalid email: ${input.ownerEmail}`,
    };
  }

  // 2. Idempotence : row déjà présente ?
  const existing = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true },
  });
  if (existing) {
    return { status: 'already_backfilled', tenantId: existing.id };
  }

  // 3. Lookup user Hub via email
  const user = await prisma.user.findUnique({
    where: { email: input.ownerEmail },
    select: { id: true, supabaseUserId: true },
  });
  if (!user || !user.supabaseUserId) {
    return { status: 'user_not_found', email: input.ownerEmail };
  }

  // 4. Si dry-run, on s'arrête là avec un preview "created" virtuel
  if (!execute) {
    return {
      status: 'created',
      tenantId: input.tenantId,
      userUuid: user.supabaseUserId,
      userId: user.id,
    };
  }

  // 5. Insert row Tenant avec champs dédiés selon l'app
  const dedicatedFields = buildDedicatedFields(input.app);
  const metadata: Record<string, unknown> = {
    [input.app]: {
      external_tenant_id: input.tenantId,
      provisioning_source: 'backfill-script',
      backfilled_at: new Date().toISOString(),
      owner_email: input.ownerEmail,
    },
  };

  await prisma.tenant.create({
    data: {
      id: input.tenantId,
      userId: user.supabaseUserId,
      name: `Backfill ${input.app} ${input.tenantId.slice(0, 8)}`,
      slug: `backfill-${input.app}-${input.tenantId}`,
      status: 'active',
      provisionedAt: new Date(),
      metadata,
      ...dedicatedFields,
    } as never,
  });

  return {
    status: 'created',
    tenantId: input.tenantId,
    userUuid: user.supabaseUserId,
    userId: user.id,
  };
}

/**
 * Renvoie les champs dédiés à hydrater selon l'app, pour rester aligné
 * avec le schéma `hub_app.tenants` (cf prisma/schema.prisma:415).
 *
 * Choix conservateur : plan par défaut = 'freemium' pour prospection,
 * 'free' pour notifuse. L'opérateur peut corriger via Stripe sync ou
 * `POST /api/admin/users/[email]/grant-plan` ensuite.
 */
function buildDedicatedFields(app: BackfillApp): Record<string, unknown> {
  switch (app) {
    case 'notifuse':
      return {
        notifusePlan: 'free',
        notifuseWorkspaceSlug: null, // pas connu via backfill, à hydrater via repair-notifuse-owners
      };
    case 'prospection':
      return {
        prospectionPlan: 'freemium',
        prospectionProvisionedAt: new Date(),
      };
    case 'analytics':
    case 'cms':
    default:
      // pas de colonnes dédiées — tout dans metadata
      return {};
  }
}

// ============================================================================
// CLI entry point — exécuté uniquement si appelé directement (pas en test)
// ============================================================================

function parseArgs(argv: string[]): {
  app?: string;
  tenantId?: string;
  ownerEmail?: string;
  execute: boolean;
} {
  const args: ReturnType<typeof parseArgs> = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') args.app = argv[++i];
    else if (a === '--tenant-id') args.tenantId = argv[++i];
    else if (a === '--owner-email') args.ownerEmail = argv[++i];
    else if (a === '--execute') args.execute = true;
  }
  return args;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.app || !parsed.tenantId || !parsed.ownerEmail) {
    console.error(
      'Usage: tsx scripts/admin/backfill-hub-tenant-from-app.ts \\\n' +
        '  --app <notifuse|prospection|analytics|cms> \\\n' +
        '  --tenant-id <uuid> \\\n' +
        '  --owner-email <email> \\\n' +
        '  [--execute]',
    );
    process.exit(2);
  }

  const mode = parsed.execute ? 'EXECUTE (write)' : 'DRY-RUN (preview)';
  console.log(`\n${'='.repeat(70)}`);
  console.log(` BACKFILL Hub Tenant from app — ${mode}`);
  console.log(` App         : ${parsed.app}`);
  console.log(` Tenant ID   : ${parsed.tenantId}`);
  console.log(` Owner email : ${parsed.ownerEmail}`);
  console.log(`${'='.repeat(70)}\n`);

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL manquant');
    process.exit(1);
  }

  // Import dynamique pour éviter d'instancier Prisma à l'import (tests)
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  const outcome = await backfillHubTenantFromApp(
    prisma,
    {
      app: parsed.app as BackfillApp,
      tenantId: parsed.tenantId,
      ownerEmail: parsed.ownerEmail,
    },
    parsed.execute,
  );

  // Log structuré pour audit (Grafana Loki si en prod via cron, sinon stdout)
  console.log(
    JSON.stringify({
      tag: '[backfill-hub-tenant-from-app]',
      ts: new Date().toISOString(),
      mode: parsed.execute ? 'execute' : 'dry-run',
      input: {
        app: parsed.app,
        tenantId: parsed.tenantId,
        ownerEmail: parsed.ownerEmail,
      },
      outcome,
    }),
  );

  // Sortie lisible pour l'opérateur
  console.log(`\nOutcome: ${outcome.status}`);
  if (outcome.status === 'created') {
    console.log(
      parsed.execute
        ? `Tenant ${outcome.tenantId} CRÉÉ (user_uuid=${outcome.userUuid})`
        : `Tenant ${outcome.tenantId} sera créé (user_uuid=${outcome.userUuid}). Relancer avec --execute.`,
    );
  } else if (outcome.status === 'already_backfilled') {
    console.log(`Tenant ${outcome.tenantId} existe déjà — pas d'action.`);
  } else if (outcome.status === 'user_not_found') {
    console.warn(
      `User Hub introuvable pour email=${outcome.email}. Orphelin profond → arbitrage humain requis.`,
    );
  } else {
    console.error(`Input invalide: ${outcome.reason}`);
    process.exit(2);
  }

  await prisma.$disconnect();
}

// Ne run main() que si le script est exécuté directement (pas importé en test)
if (require.main === module) {
  main().catch((err) => {
    console.error('UNCAUGHT:', err);
    process.exit(1);
  });
}

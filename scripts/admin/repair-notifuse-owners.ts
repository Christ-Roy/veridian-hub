#!/usr/bin/env node
/**
 * Repair des tenants Notifuse cassés (bug 2026-05-17 : owner humain pas
 * attaché au workspace côté Notifuse).
 *
 * Stratégie :
 *  1. Lister tous les tenants Hub avec `notifuseWorkspaceSlug` non-null
 *     (exclut les e2e via filtre email).
 *  2. Pour chacun, appeler `health()` côté Notifuse → si
 *     `magic_link_capable=true`, skip (tenant déjà sain).
 *  3. Sinon, appeler `attachOwner()` avec `notifuseUserEmail` → vérifier
 *     que `health()` repasse à `magic_link_capable=true`.
 *  4. Logger un récap : healthy / fixed / still_broken.
 *
 * Mode dry-run par défaut. Passer `--apply` pour exécuter les attach-owner.
 *
 * Usage :
 *   pnpm exec tsx scripts/admin/repair-notifuse-owners.ts           # dry-run
 *   pnpm exec tsx scripts/admin/repair-notifuse-owners.ts --apply   # exécute
 *
 * ENV requis (cf .env.local / shell) :
 *   DATABASE_URL                 — Postgres veridian-core-db
 *   NOTIFUSE_API_URL             — staging ou prod selon contexte
 *   NOTIFUSE_HUB_API_SECRET      — secret HMAC partagé Hub ↔ Notifuse
 *
 * Sécurité :
 *   - N'écrit JAMAIS dans la DB Hub.
 *   - L'attach-owner côté Notifuse est additif (jamais destructif).
 *   - Skip auto les tenants e2e (notifuse_user_email LIKE 'e2e-%').
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';

const APPLY = process.argv.includes('--apply');

interface TenantRow {
  id: string;
  notifuseWorkspaceSlug: string | null;
  notifuseUserEmail: string | null;
}

interface RepairResult {
  tenantId: string;
  slug: string;
  email: string;
  before: 'healthy' | 'broken' | 'unknown';
  after: 'healthy' | 'broken' | 'unknown' | 'not_applied';
  actions: string[];
  error?: string;
}

async function main(): Promise<void> {
  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl || !hubSecret) {
    console.error('❌ NOTIFUSE_API_URL ou NOTIFUSE_HUB_API_SECRET manquant');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(` REPAIR Notifuse owners — ${APPLY ? '🚨 APPLY MODE' : '🔍 DRY-RUN'}`);
  console.log(` Notifuse API : ${apiUrl}`);
  console.log(`${'═'.repeat(70)}\n`);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL manquant');
    process.exit(1);
  }
  // Parse manuellement plutôt que de passer connectionString : le password
  // peut contenir des caractères "=", "+", "/" (base64) qui foirent l'URL
  // parsing strict de pg si non urlencodés.
  const urlMatch = connectionString.match(
    /^postgresql:\/\/([^:]+):(.+)@([^:\/]+)(?::(\d+))?\/([^?]+)/,
  );
  if (!urlMatch) {
    console.error('❌ DATABASE_URL parseable failed');
    process.exit(1);
  }
  const [, user, password, host, port, database] = urlMatch;
  const adapter = new PrismaPg({
    user,
    password,
    host,
    port: port ? parseInt(port, 10) : 5432,
    database,
  });
  const prisma = new PrismaClient({ adapter });
  const client = new NotifuseClient({ apiUrl, hubSecret });

  // Tenants Hub à scanner — exclut e2e via email LIKE 'e2e-%'.
  const tenants = (await prisma.$queryRawUnsafe(`
    SELECT
      id,
      notifuse_workspace_slug AS "notifuseWorkspaceSlug",
      notifuse_user_email AS "notifuseUserEmail"
    FROM hub_app.tenants
    WHERE notifuse_workspace_slug IS NOT NULL
      AND notifuse_user_email IS NOT NULL
      AND notifuse_user_email NOT LIKE 'e2e-%'
    ORDER BY created_at ASC
  `)) as TenantRow[];

  console.log(`📋 ${tenants.length} tenant(s) Hub à scanner\n`);

  const results: RepairResult[] = [];

  for (const tenant of tenants) {
    if (!tenant.notifuseWorkspaceSlug || !tenant.notifuseUserEmail) continue;

    const slug = tenant.notifuseWorkspaceSlug;
    const email = tenant.notifuseUserEmail;
    const r: RepairResult = {
      tenantId: tenant.id,
      slug,
      email,
      before: 'unknown',
      after: 'not_applied',
      actions: [],
    };

    // Étape 1 : health AVANT
    try {
      const health = await client.getHealth(slug);
      r.before = health.magic_link_capable ? 'healthy' : 'broken';
      r.actions.push(
        `health(before) → owner_attached=${health.owner_attached}, owner_email=${health.owner_email}, magic_link_capable=${health.magic_link_capable}`,
      );
    } catch (err) {
      r.before = 'unknown';
      r.error = err instanceof NotifuseError ? `health: ${err.code} ${err.message}` : String(err);
      r.actions.push(`❌ health failed: ${r.error}`);
      results.push(r);
      continue;
    }

    if (r.before === 'healthy') {
      r.after = 'healthy';
      r.actions.push('✅ déjà sain — skip');
      results.push(r);
      continue;
    }

    // Étape 2 : attach-owner si broken
    if (!APPLY) {
      r.actions.push(`🔍 DRY-RUN — aurait attaché ${email} comme owner sur ${slug}`);
      results.push(r);
      continue;
    }

    try {
      const attach = await client.attachOwner({
        tenantId: slug,
        ownerEmail: email,
        role: 'owner',
      });
      r.actions.push(
        `attach-owner → user_id=${attach.user_id}, attached=${attach.attached}, already_attached=${attach.already_attached}, owner_transferred=${attach.owner_transferred ?? false}`,
      );
    } catch (err) {
      r.error = err instanceof NotifuseError ? `attach: ${err.code} ${err.message}` : String(err);
      r.actions.push(`❌ attach failed: ${r.error}`);
      results.push(r);
      continue;
    }

    // Étape 3 : health APRÈS
    try {
      const health = await client.getHealth(slug);
      r.after = health.magic_link_capable ? 'healthy' : 'broken';
      r.actions.push(
        `health(after) → owner_attached=${health.owner_attached}, owner_email=${health.owner_email}, magic_link_capable=${health.magic_link_capable}`,
      );
    } catch (err) {
      r.after = 'unknown';
      r.error = `health(after) failed: ${err instanceof NotifuseError ? err.message : String(err)}`;
      r.actions.push(`❌ ${r.error}`);
    }

    results.push(r);
  }

  // Récap
  console.log(`\n${'─'.repeat(70)}`);
  console.log(' RÉSULTATS PAR TENANT');
  console.log(`${'─'.repeat(70)}\n`);

  for (const r of results) {
    const flag =
      r.after === 'healthy' ? '🟢' : r.before === 'broken' && !APPLY ? '🟡' : '🔴';
    console.log(`${flag} ${r.email} (${r.slug})`);
    console.log(`   tenant_id : ${r.tenantId}`);
    console.log(`   before    : ${r.before}`);
    console.log(`   after     : ${r.after}`);
    for (const a of r.actions) {
      console.log(`     - ${a}`);
    }
    console.log('');
  }

  // Summary
  const healthy = results.filter((r) => r.before === 'healthy').length;
  const fixedNow = results.filter((r) => r.before === 'broken' && r.after === 'healthy').length;
  const wouldFix = results.filter((r) => r.before === 'broken' && r.after === 'not_applied').length;
  const stillBroken = results.filter((r) => r.before === 'broken' && r.after !== 'healthy' && r.after !== 'not_applied').length;
  const errors = results.filter((r) => !!r.error).length;

  console.log(`${'═'.repeat(70)}`);
  console.log(' SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Tenants scannés     : ${results.length}`);
  console.log(`  Déjà sains          : ${healthy}`);
  if (APPLY) {
    console.log(`  Réparés             : ${fixedNow}`);
    console.log(`  Toujours cassés     : ${stillBroken}`);
  } else {
    console.log(`  À réparer (dry-run) : ${wouldFix}`);
  }
  console.log(`  Erreurs             : ${errors}`);
  console.log('');

  if (!APPLY && wouldFix > 0) {
    console.log(`💡 Relancer avec --apply pour réparer les ${wouldFix} tenant(s) cassé(s).`);
  }

  await prisma.$disconnect();
  process.exit(errors > 0 || stillBroken > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});

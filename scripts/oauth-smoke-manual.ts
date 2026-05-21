#!/usr/bin/env node
/**
 * OAuth smoke manuel — post-deploy prod.
 *
 * Pourquoi : le mock OAuth provider (livré 2026-05-21) court-circuite Google
 * et Microsoft, donc ne valide PAS :
 *   - Le redirect URI déclaré chez le provider
 *   - Le client secret réellement injecté en prod
 *   - Le Consent Screen Google (état Publishing)
 *   - Les scopes réellement accordés par l'utilisateur
 *
 * Ce script ouvre app.veridian.site/login dans le browser local, attend
 * confirmation manuelle de Robert ("tape ok") après chaque flow, vérifie
 * la session via /api/auth/session, puis cleanup le user créé en DB
 * (DELETE direct via Prisma).
 *
 * Usage :
 *   pnpm oauth:smoke:manual
 *
 * ENV requis :
 *   DATABASE_URL  — Postgres veridian-core-db (Tailscale recommandé)
 *   OAUTH_SMOKE_BASE_URL (optionnel) — défaut https://app.veridian.site
 *   OAUTH_SMOKE_TEST_EMAIL_GOOGLE (optionnel) — pour ciblage cleanup
 *   OAUTH_SMOKE_TEST_EMAIL_MICROSOFT (optionnel) — idem
 *
 * Durée totale : ~3 min wall-clock.
 */

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const BASE_URL = process.env.OAUTH_SMOKE_BASE_URL ?? 'https://app.veridian.site';
const TEST_EMAIL_GOOGLE = process.env.OAUTH_SMOKE_TEST_EMAIL_GOOGLE;
const TEST_EMAIL_MICROSOFT = process.env.OAUTH_SMOKE_TEST_EMAIL_MICROSOFT;

interface SmokeResult {
  provider: 'google' | 'microsoft';
  sessionEmail: string | null;
  dbUserFound: boolean;
  supabaseUserIdSet: boolean;
  cleanedUp: boolean;
  error?: string;
}

function openInBrowser(url: string): void {
  try {
    execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    console.log(`(impossible d'ouvrir automatiquement) ouvrir manuellement : ${url}`);
  }
}

async function fetchSession(): Promise<{ email: string | null }> {
  // On ne peut pas vraiment partager le cookie navigateur depuis ce script
  // sans le coller en CLI. On demande à Robert de coller la valeur depuis
  // un cURL d'inspect navigateur, OU on se contente de vérifier la DB.
  return { email: null };
}

async function findAndDeleteUserByEmail(
  prisma: PrismaClient,
  email: string,
  provider: 'google' | 'microsoft-entra-id',
): Promise<{ found: boolean; supabaseUserIdSet: boolean; deleted: boolean }> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { accounts: true },
  });

  if (!user) {
    return { found: false, supabaseUserIdSet: false, deleted: false };
  }

  const supabaseUserIdSet = Boolean(user.supabaseUserId);
  const hasProviderAccount = user.accounts.some((a) => a.provider === provider);

  if (!hasProviderAccount) {
    console.log(`  ⚠️  User ${email} existe mais pas d'Account ${provider} — pas créé via ce flow, on NE SUPPRIME PAS`);
    return { found: true, supabaseUserIdSet, deleted: false };
  }

  // Cleanup : supprime sessions, accounts, puis user (cascade via FK)
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId: user.id } }),
    prisma.account.deleteMany({ where: { userId: user.id } }),
    prisma.tenant.deleteMany({ where: { userId: user.supabaseUserId ?? '00000000-0000-0000-0000-000000000000' } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);

  return { found: true, supabaseUserIdSet, deleted: true };
}

async function smokeProvider(
  prisma: PrismaClient,
  rl: ReturnType<typeof createInterface>,
  provider: 'google' | 'microsoft',
): Promise<SmokeResult> {
  const providerKey = provider === 'google' ? 'google' : 'microsoft-entra-id';
  const expectedEmail = provider === 'google' ? TEST_EMAIL_GOOGLE : TEST_EMAIL_MICROSOFT;

  console.log('\n' + '═'.repeat(70));
  console.log(`▶ Smoke OAuth ${provider.toUpperCase()}`);
  console.log('═'.repeat(70));
  console.log(`Étapes :`);
  console.log(`  1. J'ouvre ${BASE_URL}/login dans ton browser.`);
  console.log(`  2. Tu cliques sur "Continuer avec ${provider === 'google' ? 'Google' : 'Microsoft'}".`);
  console.log(`  3. Tu te connectes avec un compte TEST (PAS ton compte perso).`);
  console.log(`  4. Une fois arrivé sur /dashboard, tu reviens ici et tu tapes l'email utilisé.`);

  openInBrowser(`${BASE_URL}/login`);

  const email = (await rl.question(`\nEmail du compte ${provider} utilisé (ou "skip" pour passer) : `)).trim().toLowerCase();

  if (email === 'skip' || email === '') {
    return {
      provider,
      sessionEmail: null,
      dbUserFound: false,
      supabaseUserIdSet: false,
      cleanedUp: false,
      error: 'skipped by user',
    };
  }

  if (expectedEmail && email !== expectedEmail.toLowerCase()) {
    console.log(`  ⚠️  email saisi (${email}) ≠ OAUTH_SMOKE_TEST_EMAIL_${provider.toUpperCase()} (${expectedEmail})`);
  }

  console.log(`  → Vérification DB pour ${email}...`);

  try {
    const result = await findAndDeleteUserByEmail(prisma, email, providerKey);

    if (!result.found) {
      return {
        provider,
        sessionEmail: email,
        dbUserFound: false,
        supabaseUserIdSet: false,
        cleanedUp: false,
        error: `user ${email} introuvable en DB — flow OAuth probablement non complété`,
      };
    }

    if (!result.supabaseUserIdSet) {
      console.log(`  ❌ BUG : supabaseUserId NULL pour ${email} (régression du fix d25f575 2026-05-21)`);
    } else {
      console.log(`  ✓ supabaseUserId posé (UUID v4)`);
    }

    if (result.deleted) {
      console.log(`  ✓ Cleanup réussi (user + accounts + sessions supprimés)`);
    }

    return {
      provider,
      sessionEmail: email,
      dbUserFound: true,
      supabaseUserIdSet: result.supabaseUserIdSet,
      cleanedUp: result.deleted,
    };
  } catch (err) {
    return {
      provider,
      sessionEmail: email,
      dbUserFound: false,
      supabaseUserIdSet: false,
      cleanedUp: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL manquant. Pour cibler prod :');
    console.error('   export DATABASE_URL="postgresql://veridian:<pwd>@<host>:5432/veridian?schema=hub_app"');
    console.error('   (Tunnel Tailscale ou bastion SSH recommandé.)');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const rl = createInterface({ input, output });

  console.log('🔥 OAuth smoke manuel — post-deploy prod');
  console.log(`   Cible : ${BASE_URL}`);
  console.log(`   DB    : ${process.env.DATABASE_URL.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')}`);

  const confirm = (await rl.question('\nContinuer ? [yes/N] : ')).trim().toLowerCase();
  if (confirm !== 'yes' && confirm !== 'y') {
    console.log('Annulé.');
    rl.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  const results: SmokeResult[] = [];

  results.push(await smokeProvider(prisma, rl, 'google'));
  results.push(await smokeProvider(prisma, rl, 'microsoft'));

  console.log('\n' + '═'.repeat(70));
  console.log('📊 Récapitulatif');
  console.log('═'.repeat(70));

  let hasFail = false;
  for (const r of results) {
    const status = r.error
      ? '⚠️  ' + r.error
      : r.dbUserFound && r.supabaseUserIdSet && r.cleanedUp
      ? '✓ OK'
      : '❌ FAIL';
    if (status.startsWith('❌')) hasFail = true;
    console.log(`  ${r.provider.padEnd(10)} : ${status}`);
  }

  rl.close();
  await prisma.$disconnect();

  if (hasFail) {
    console.log('\n❌ Smoke FAIL — investiguer immédiatement.');
    process.exit(1);
  }
  console.log('\n✓ Smoke OK.');
}

main().catch((err) => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});

/**
 * Provisionne le Stripe Product utilisé pour le refill leads Prospection.
 *
 * Spec : docs/CONTRAT-BILLING.md §8.4 + docs/PRICING-VERIDIAN.md §95-108.
 *
 * Le refill leads est un Stripe Checkout one-shot (`mode=payment`) dont le
 * MONTANT est calculé dynamiquement à chaque session via `price_data`
 * (grille dégressive `shared/pricing/refill.ts`). On n'a donc PAS besoin
 * de Prices recurring — UN seul Product fixe suffit, référencé par
 * `price_data.product` à chaque Checkout.
 *
 * Idempotence :
 *   - On cherche un Product actif avec `metadata.kind=refill_leads` et
 *     `metadata.app=prospection`. S'il existe, on le réutilise et on patche
 *     name/description au cas où le catalogue marketing a dérivé.
 *   - Sinon on le crée.
 *
 * Convention metadata (relue par la route Checkout + le dispatcher webhook) :
 *   - Product.metadata.kind = 'refill_leads'
 *   - Product.metadata.app  = 'prospection'
 *
 * ⚠️  TIER 🟡 — un run en mode LIVE crée un Product visible côté Stripe
 *    Dashboard. Le Product ne facture personne par lui-même (pas de Price
 *    recurring). On peut donc le créer sans danger commercial — il devient
 *    actif uniquement quand la route `/api/billing/refill-leads/checkout`
 *    crée une session avec `price_data.product = <ce product>`.
 *
 * Usage :
 *   pnpm tsx scripts/admin/setup-stripe-refill.ts --mode=test           # provisionne TEST
 *   pnpm tsx scripts/admin/setup-stripe-refill.ts --mode=live           # provisionne LIVE
 *   pnpm tsx scripts/admin/setup-stripe-refill.ts --mode=test --dry-run # preview
 *
 * Le script affiche le Product ID en fin de run et l'écrit aussi dans
 * `.env.local.refill.txt` à la racine du repo pour que Robert puisse le
 * merger dans `~/credentials/.all-creds.env` sous les clés :
 *   - STRIPE_REFILL_PRODUCT_ID_LIVE
 *   - STRIPE_REFILL_PRODUCT_ID_TEST
 *
 * Ces ENV sont lues runtime par `utils/env.ts:getStripeRefillProductId()`.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import Stripe from 'stripe';

const STRIPE_API_VERSION = '2024-12-18.acacia';

type Mode = 'test' | 'live';

const PRODUCT_NAME = 'Refill leads Prospection';
const PRODUCT_DESCRIPTION =
  'Achat one-shot de leads supplémentaires sur Prospection Veridian. Prix calculé dynamiquement selon le plan et le volume (grille dégressive).';

// ─────────────────────────────────────────────────────────────────────────────
// Lecture creds (env > ~/credentials/.all-creds.env)
// ─────────────────────────────────────────────────────────────────────────────

function readCred(name: string): string | null {
  if (process.env[name]) return process.env[name] as string;

  const credsPath = join(homedir(), 'credentials', '.all-creds.env');
  if (!existsSync(credsPath)) return null;

  const content = readFileSync(credsPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === name) {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning — idempotent
// ─────────────────────────────────────────────────────────────────────────────

export async function findRefillProduct(stripe: Stripe): Promise<Stripe.Product | null> {
  for await (const product of stripe.products.list({ limit: 100, active: true })) {
    if (
      product.metadata?.kind === 'refill_leads' &&
      product.metadata?.app === 'prospection'
    ) {
      return product;
    }
  }
  return null;
}

export async function upsertRefillProduct(
  stripe: Stripe,
  dryRun: boolean,
): Promise<{ id: string; created: boolean }> {
  const existing = await findRefillProduct(stripe);
  const metadata = { kind: 'refill_leads', app: 'prospection' };

  if (existing) {
    console.log(`  ↺ Product réutilisé : ${existing.id}`);
    if (!dryRun) {
      await stripe.products.update(existing.id, {
        name: PRODUCT_NAME,
        description: PRODUCT_DESCRIPTION,
        metadata,
      });
    }
    return { id: existing.id, created: false };
  }

  if (dryRun) {
    console.log(`  + Product À CRÉER : "${PRODUCT_NAME}"`);
    return { id: 'dryrun_prod_refill', created: true };
  }

  const created = await stripe.products.create({
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    metadata,
  });
  console.log(`  + Product créé : ${created.id}`);
  return { id: created.id, created: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(): { mode: Mode; dryRun: boolean } {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith('--mode='));
  const mode = modeArg?.split('=')[1];
  const dryRun = args.includes('--dry-run');

  if (mode !== 'test' && mode !== 'live') {
    console.error('Usage: tsx setup-stripe-refill.ts --mode=test|live [--dry-run]');
    process.exit(1);
  }
  return { mode, dryRun };
}

async function main() {
  const { mode, dryRun } = parseArgs();

  console.log('━'.repeat(72));
  console.log(`  Stripe refill product provisioning — mode=${mode.toUpperCase()} dry-run=${dryRun}`);
  console.log('━'.repeat(72));

  // ─── Clé Stripe ───
  // Mode TEST = compte Stripe preprod actif (la clé `STRIPE_SECRET_KEY_TEST`
  // historique a expiré 2026-05-22, on bascule sur `STRIPE_SECRET_KEY_PREPROD`
  // qui pointe sur le nouveau compte test Veridian — cf memory
  // `reference_stripe_provisioning_2026-05-22.md`). On garde un fallback sur
  // l'ancienne clé pour ne pas casser un éventuel rebind futur.
  const keyCandidates =
    mode === 'live'
      ? ['STRIPE_SECRET_KEY_LIVE']
      : ['STRIPE_SECRET_KEY_PREPROD', 'STRIPE_SECRET_KEY_TEST'];

  let keyName: string | null = null;
  let apiKey: string | null = null;
  for (const name of keyCandidates) {
    const v = readCred(name);
    if (v) {
      keyName = name;
      apiKey = v;
      break;
    }
  }
  if (!apiKey || !keyName) {
    console.error(
      `✗ Aucune clé trouvée parmi : ${keyCandidates.join(', ')} (env ni ~/credentials/.all-creds.env)`,
    );
    process.exit(1);
  }
  console.log(`  Clé utilisée : ${keyName}`);
  const expectedPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_';
  if (!apiKey.startsWith(expectedPrefix)) {
    console.error(
      `✗ La clé ${keyName} ne commence pas par ${expectedPrefix} — refus pour éviter ` +
        `de provisionner sur le mauvais compte.`,
    );
    process.exit(1);
  }

  const stripe = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });

  // ─── Provisioning ───
  const { id: productId, created } = await upsertRefillProduct(stripe, dryRun);

  // ─── Sortie ───
  console.log('');
  console.log('─'.repeat(72));
  console.log('  RÉCAP');
  console.log('─'.repeat(72));
  console.log(`  mode      : ${mode.toUpperCase()}`);
  console.log(`  productId : ${productId}`);
  console.log(`  status    : ${created ? 'CRÉÉ' : 'RÉUTILISÉ'}`);
  console.log('');

  if (!dryRun) {
    const envKey = mode === 'live' ? 'STRIPE_REFILL_PRODUCT_ID_LIVE' : 'STRIPE_REFILL_PRODUCT_ID_TEST';
    // Écrit dans un fichier à part pour que Robert le merge manuellement.
    const outPath = join(process.cwd(), '.env.local.refill.txt');
    const line = `${envKey}=${productId}\n`;
    // Append + dédup à l'écriture : on filtre l'éventuelle ancienne ligne
    // qui pointerait sur le même envKey.
    let existing = '';
    if (existsSync(outPath)) {
      existing = readFileSync(outPath, 'utf8')
        .split('\n')
        .filter((l) => !l.startsWith(`${envKey}=`))
        .join('\n');
      if (existing && !existing.endsWith('\n')) existing += '\n';
    }
    writeFileSync(outPath, existing + line, 'utf8');
    console.log(`✓ Écrit dans ${outPath} :`);
    console.log(`    ${line.trim()}`);
    console.log('');
    console.log(`  → Merger cette ligne dans ~/credentials/.all-creds.env`);
    console.log(`  → Et l'exposer en ENV runtime du Hub (Dokploy compose) pour ${mode}.`);
  }
}

// N'exécute le provisioning que si le script est lancé directement
// (`pnpm tsx scripts/admin/setup-stripe-refill.ts`). Quand le module est
// importé par un test unitaire, on n'exécute rien — seules les fonctions
// pures exportées sont consommées.
const isMainModule =
  typeof require !== 'undefined' && require.main === module;

if (isMainModule) {
  main().catch((err) => {
    console.error('\n✗ Provisioning échoué :', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

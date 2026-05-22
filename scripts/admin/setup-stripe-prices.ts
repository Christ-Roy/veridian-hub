/**
 * Provisioning des Products + Prices Stripe Veridian.
 *
 * Ticket : todo/2026-05-21-pricing-sync-stripe-products.md (BLOC 1b).
 *
 * Ce script lit le catalogue canonique `shared/shared/pricing/plans.ts`
 * (grille v1.1) et provisionne dans Stripe :
 *   - 1 Product par plan payant (`plan_source === 'stripe'` && `price_eur > 0`)
 *   - 2 Prices par Product : un `month`, un `year` (le `year` n'est créé que
 *     si le plan a un `price_eur_yearly_per_month` non-null)
 *
 * Convention metadata OBLIGATOIRE (relue par le dispatcher webhook) :
 *   - Product.metadata.veridian_plan = la PlanKey (ex `notifuse-pro`)
 *   - Product.metadata.veridian_apps = apps débloquées, CSV (ex `notifuse,prospection`)
 *   - Price.metadata.veridian_plan   = la PlanKey (redondance utile au lookup)
 *   - Price.metadata.interval        = `month` | `year`
 *
 * Idempotence :
 *   - Un Product est identifié par `metadata.veridian_plan`. Si un Product
 *     actif portant cette clé existe déjà, on le réutilise (on patche son
 *     name/description si dérive).
 *   - Un Price est identifié par (`product`, `metadata.interval`, `unit_amount`,
 *     `recurring.interval`). Stripe interdit de muter le montant d'un Price ;
 *     si un Price actif au bon montant existe déjà → réutilisé. Si un Price
 *     existe à un AUTRE montant → l'ancien est archivé et un neuf est créé.
 *
 * Après création, le script RÉÉCRIT `shared/shared/pricing/plans.ts` en
 * remplissant `stripePriceIdLive` / `stripePriceIdTest` de chaque plan.
 *
 * ⚠️ TIER 💀 — le run en mode LIVE crée de VRAIS produits de vente. Faire
 *    le run TEST d'abord, vérifier, PUIS obtenir le GO explicite de Robert.
 *
 * Usage :
 *   pnpm tsx scripts/admin/setup-stripe-prices.ts --mode=test           # provisionne TEST
 *   pnpm tsx scripts/admin/setup-stripe-prices.ts --mode=live           # provisionne LIVE
 *   pnpm tsx scripts/admin/setup-stripe-prices.ts --mode=test --dry-run # preview, aucun call d'écriture
 *
 * Clés lues (depuis l'env ou ~/credentials/.all-creds.env) :
 *   - mode=test : STRIPE_SECRET_KEY_TEST
 *   - mode=live : STRIPE_SECRET_KEY_LIVE
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import Stripe from 'stripe';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** Chemin du catalogue canonique (source de vérité ET cible de réécriture). */
const PLANS_FILE = join(__dirname, '..', '..', 'shared', 'shared', 'pricing', 'plans.ts');

const CURRENCY = 'eur';
/** Aligné sur utils/stripe/config.ts pour ne pas mixer les versions d'API. */
const STRIPE_API_VERSION = '2024-12-18.acacia';

type Mode = 'test' | 'live';

export interface PlanInput {
  /** PlanKey canonique. */
  key: string;
  /** Nom marketing affiché. */
  name: string;
  /** Sous-titre court. */
  tagline: string;
  /** Apps débloquées. */
  apps: string[];
  /** Prix mensuel EUR. */
  priceEurMonth: number;
  /** Prix annuel/mois EUR — null si pas d'option annuelle. */
  priceEurYearPerMonth: number | null;
}

export interface ProvisionedPrice {
  month: string;
  year: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture des creds (env d'abord, fichier ~/.all-creds.env en fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère une variable depuis l'environnement, sinon depuis le fichier
 * centralisé `~/credentials/.all-creds.env` (lecture ligne par ligne pour ne
 * pas se faire piéger par les lignes commentées / non-`KEY=VALUE`).
 */
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
// Extraction des plans payants depuis le catalogue canonique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse `shared/shared/pricing/plans.ts` et en extrait les plans payants à
 * provisionner. On parse le fichier source plutôt que de l'importer pour deux
 * raisons : (1) on doit de toute façon le réécrire (donc on garde son texte
 * en main), (2) éviter une dépendance d'exécution sur les alias TS dans un
 * script standalone tsx.
 *
 * Stratégie : on découpe sur les blocs `'key': { ... }` du Record PLANS et on
 * extrait les champs nécessaires. Un plan est "payant" ssi
 * `plan_source: 'stripe'` ET `price_eur` > 0.
 */
export function extractPayablePlans(source: string): PlanInput[] {
  const plans: PlanInput[] = [];

  // Chaque entrée du Record PLANS : `  'notifuse-pro': {` ... `  },`
  // On capture la clé puis le corps jusqu'au `},` au même niveau d'indentation.
  const entryRe = /^ {2}'([a-z0-9-]+)':\s*\{$/gm;
  let match: RegExpExecArray | null;

  while ((match = entryRe.exec(source)) !== null) {
    const key = match[1];
    const bodyStart = match.index + match[0].length;
    // Le bloc se termine au premier `\n  },` (indentation 2 espaces).
    const bodyEnd = source.indexOf('\n  },', bodyStart);
    if (bodyEnd === -1) continue;
    const body = source.slice(bodyStart, bodyEnd);

    const planSource = field(body, 'plan_source');
    const priceEurRaw = field(body, 'price_eur');
    if (planSource !== 'stripe' || priceEurRaw === null) continue;

    const priceEur = Number(priceEurRaw);
    if (!Number.isFinite(priceEur) || priceEur <= 0) continue;

    const yearlyRaw = field(body, 'price_eur_yearly_per_month');
    const priceYear =
      yearlyRaw === null || yearlyRaw === 'null' ? null : Number(yearlyRaw);

    const appsRaw = arrayField(body, 'apps_unlocked');

    plans.push({
      key,
      name: stringField(body, 'name') ?? key,
      tagline: stringField(body, 'tagline') ?? '',
      apps: appsRaw,
      priceEurMonth: priceEur,
      priceEurYearPerMonth:
        priceYear !== null && Number.isFinite(priceYear) ? priceYear : null,
    });
  }

  return plans;
}

/** Extrait la valeur brute (sans quotes) d'un champ `name: value,` d'un bloc. */
function field(body: string, name: string): string | null {
  const re = new RegExp(`\\b${name}:\\s*([^,\\n]+)`);
  const m = body.match(re);
  if (!m) return null;
  return m[1].trim().replace(/['"]/g, '');
}

/** Extrait un champ string en gardant la valeur exacte entre quotes. */
function stringField(body: string, name: string): string | null {
  const re = new RegExp(`\\b${name}:\\s*'([^']*)'`);
  const m = body.match(re);
  return m ? m[1] : null;
}

/** Extrait un champ tableau de strings `['a', 'b']`. */
function arrayField(body: string, name: string): string[] {
  const re = new RegExp(`\\b${name}:\\s*\\[([^\\]]*)\\]`);
  const m = body.match(re);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning Stripe — idempotent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trouve un Product actif portant `metadata.veridian_plan === planKey`.
 * Stripe ne permet pas de filtrer products par metadata via l'API list, on
 * pagine donc et on filtre côté script (volumétrie faible — < 10 products).
 */
async function findProductByPlanKey(
  stripe: Stripe,
  planKey: string,
): Promise<Stripe.Product | null> {
  for await (const product of stripe.products.list({ limit: 100, active: true })) {
    if (product.metadata?.veridian_plan === planKey) {
      return product;
    }
  }
  return null;
}

/** Crée (ou réutilise) le Product d'un plan. */
async function upsertProduct(
  stripe: Stripe,
  plan: PlanInput,
  dryRun: boolean,
): Promise<Stripe.Product> {
  const existing = await findProductByPlanKey(stripe, plan.key);
  const metadata = {
    veridian_plan: plan.key,
    veridian_apps: plan.apps.join(','),
  };

  if (existing) {
    console.log(`  ↺ Product réutilisé : ${existing.id} (${plan.key})`);
    if (!dryRun) {
      // Re-patche name/description/metadata au cas où le catalogue a dérivé.
      await stripe.products.update(existing.id, {
        name: plan.name,
        description: plan.tagline,
        metadata,
      });
    }
    return existing;
  }

  if (dryRun) {
    console.log(`  + Product À CRÉER : ${plan.key} — "${plan.name}"`);
    return { id: `dryrun_prod_${plan.key}` } as Stripe.Product;
  }

  const created = await stripe.products.create({
    name: plan.name,
    description: plan.tagline,
    metadata,
  });
  console.log(`  + Product créé : ${created.id} (${plan.key})`);
  return created;
}

/**
 * Crée (ou réutilise) le Price d'un Product pour un interval donné.
 * Montant en centimes. Idempotent : réutilise un Price actif au bon montant ;
 * archive un Price obsolète (montant différent) avant d'en créer un neuf.
 */
async function upsertPrice(
  stripe: Stripe,
  product: Stripe.Product,
  planKey: string,
  interval: 'month' | 'year',
  amountCents: number,
  dryRun: boolean,
): Promise<string> {
  // Stripe Price.recurring.interval : pour l'annuel facturé en 1 fois, c'est
  // `year`. Notre catalogue stocke un prix "par mois facturé annuellement" —
  // on multiplie ×12 pour le montant facturé annuellement.
  const recurringInterval: Stripe.PriceCreateParams.Recurring.Interval =
    interval === 'year' ? 'year' : 'month';

  if (product.id.startsWith('dryrun_')) {
    console.log(
      `    + Price À CRÉER : ${planKey}/${interval} — ${(amountCents / 100).toFixed(2)}€`,
    );
    return `dryrun_price_${planKey}_${interval}`;
  }

  // Cherche un Price existant : même product, même interval metadata, actif.
  for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) {
    if (price.metadata?.interval !== interval) continue;
    if (price.active && price.unit_amount === amountCents && price.currency === CURRENCY) {
      console.log(`    ↺ Price réutilisé : ${price.id} (${planKey}/${interval})`);
      return price.id;
    }
    // Price obsolète (mauvais montant) → on l'archive avant d'en créer un neuf.
    if (price.active) {
      if (!dryRun) await stripe.prices.update(price.id, { active: false });
      console.log(
        `    ⚠ Price obsolète archivé : ${price.id} (montant ${price.unit_amount} ≠ ${amountCents})`,
      );
    }
  }

  if (dryRun) {
    console.log(
      `    + Price À CRÉER : ${planKey}/${interval} — ${(amountCents / 100).toFixed(2)}€`,
    );
    return `dryrun_price_${planKey}_${interval}`;
  }

  const created = await stripe.prices.create({
    product: product.id,
    currency: CURRENCY,
    unit_amount: amountCents,
    recurring: { interval: recurringInterval },
    metadata: { veridian_plan: planKey, interval },
  });
  console.log(`    + Price créé : ${created.id} (${planKey}/${interval})`);
  return created.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Réécriture du catalogue avec les Price IDs retournés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Réécrit `stripePriceIdLive` ou `stripePriceIdTest` du plan `planKey` dans le
 * texte source du catalogue. Remplacement ciblé : on isole le bloc du plan,
 * puis on remplace la ligne `stripePriceId<Env>: { ... }`.
 */
export function patchPlanPriceIds(
  source: string,
  planKey: string,
  env: 'Live' | 'Test',
  ids: ProvisionedPrice,
): string {
  const fieldName = `stripePriceId${env}`;
  const monthVal = ids.month ? `'${ids.month}'` : 'null';
  const yearVal = ids.year ? `'${ids.year}'` : 'null';
  const replacement = `${fieldName}: { month: ${monthVal}, year: ${yearVal} }`;

  // Localise le bloc du plan : `  'key': {` ... `\n  },`
  const entryRe = new RegExp(`^ {2}'${planKey}':\\s*\\{$`, 'm');
  const entryMatch = source.match(entryRe);
  if (!entryMatch || entryMatch.index === undefined) {
    console.warn(`  ⚠ patchPlanPriceIds : plan ${planKey} introuvable dans le source`);
    return source;
  }
  const blockStart = entryMatch.index;
  const blockEnd = source.indexOf('\n  },', blockStart);
  if (blockEnd === -1) return source;

  const before = source.slice(0, blockStart);
  const block = source.slice(blockStart, blockEnd);
  const after = source.slice(blockEnd);

  // Remplace la ligne stripePriceId<Env>: { ... } (sur une seule ligne).
  const lineRe = new RegExp(`${fieldName}:\\s*\\{[^}]*\\}`);
  if (!lineRe.test(block)) {
    console.warn(`  ⚠ patchPlanPriceIds : champ ${fieldName} introuvable pour ${planKey}`);
    return source;
  }
  const patchedBlock = block.replace(lineRe, replacement);
  return before + patchedBlock + after;
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
    console.error('Usage: tsx setup-stripe-prices.ts --mode=test|live [--dry-run]');
    process.exit(1);
  }
  return { mode, dryRun };
}

async function main() {
  const { mode, dryRun } = parseArgs();

  console.log('━'.repeat(72));
  console.log(`  Stripe provisioning — mode=${mode.toUpperCase()} dry-run=${dryRun}`);
  console.log('━'.repeat(72));

  if (mode === 'live' && !dryRun) {
    console.log('');
    console.log('  🔴 MODE LIVE — création de PRODUITS DE VENTE RÉELS.');
    console.log('  🔴 Ce run nécessite le GO explicite de Robert (tier 💀).');
    console.log('');
  }

  // ─── Clé Stripe ───
  const keyName = mode === 'live' ? 'STRIPE_SECRET_KEY_LIVE' : 'STRIPE_SECRET_KEY_TEST';
  const apiKey = readCred(keyName);
  if (!apiKey) {
    console.error(`✗ Clé ${keyName} introuvable (env ni ~/credentials/.all-creds.env)`);
    process.exit(1);
  }
  const expectedPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_';
  if (!apiKey.startsWith(expectedPrefix)) {
    console.error(
      `✗ La clé ${keyName} ne commence pas par ${expectedPrefix} — refus pour éviter ` +
        `de provisionner sur le mauvais compte.`,
    );
    process.exit(1);
  }

  const stripe = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });

  // ─── Catalogue ───
  const source = readFileSync(PLANS_FILE, 'utf8');
  const plans = extractPayablePlans(source);
  console.log(`\n${plans.length} plan(s) payant(s) à provisionner :`);
  for (const p of plans) {
    const yearly = p.priceEurYearPerMonth !== null ? `, year ${p.priceEurYearPerMonth}€/mo` : '';
    console.log(`  • ${p.key} — ${p.priceEurMonth}€/mo${yearly} [${p.apps.join('+')}]`);
  }

  if (plans.length === 0) {
    console.error('✗ Aucun plan payant extrait — le parser a un problème, abandon.');
    process.exit(1);
  }

  // ─── Provisioning ───
  const results: Record<string, ProvisionedPrice> = {};

  for (const plan of plans) {
    console.log(`\n▸ ${plan.key}`);
    const product = await upsertProduct(stripe, plan, dryRun);

    const monthId = await upsertPrice(
      stripe,
      product,
      plan.key,
      'month',
      Math.round(plan.priceEurMonth * 100),
      dryRun,
    );

    let yearId: string | null = null;
    if (plan.priceEurYearPerMonth !== null) {
      // Le catalogue stocke le prix "par mois facturé annuellement" → ×12.
      yearId = await upsertPrice(
        stripe,
        product,
        plan.key,
        'year',
        Math.round(plan.priceEurYearPerMonth * 12 * 100),
        dryRun,
      );
    }

    results[plan.key] = { month: monthId, year: yearId };
  }

  // ─── Réécriture du catalogue ───
  if (dryRun) {
    console.log('\n[dry-run] catalogue NON modifié.');
  } else {
    const envLabel: 'Live' | 'Test' = mode === 'live' ? 'Live' : 'Test';
    let patched = source;
    for (const [planKey, ids] of Object.entries(results)) {
      patched = patchPlanPriceIds(patched, planKey, envLabel, ids);
    }
    writeFileSync(PLANS_FILE, patched, 'utf8');
    console.log(`\n✓ Catalogue mis à jour : stripePriceId${envLabel} rempli pour ${plans.length} plan(s).`);
    console.log(`  Fichier : ${PLANS_FILE}`);
  }

  // ─── Récap ───
  console.log('\n' + '─'.repeat(72));
  console.log('  RÉCAP — Price IDs');
  console.log('─'.repeat(72));
  for (const [planKey, ids] of Object.entries(results)) {
    console.log(`  ${planKey.padEnd(24)} month=${ids.month}  year=${ids.year ?? '—'}`);
  }
  console.log('');
  console.log(`✓ Provisioning ${mode.toUpperCase()} terminé.`);
  if (!dryRun && mode === 'test') {
    console.log('  → Vérifie le compte Stripe TEST, puis demande le GO Robert pour le run LIVE.');
  }
}

// N'exécute le provisioning que si le script est lancé directement
// (`pnpm tsx scripts/admin/setup-stripe-prices.ts`). Quand le module est
// importé par un test unitaire, on n'exécute rien — seules les fonctions
// pures exportées (extractPayablePlans, patchPlanPriceIds) sont consommées.
const isMainModule =
  typeof require !== 'undefined' && require.main === module;

if (isMainModule) {
  main().catch((err) => {
    console.error('\n✗ Provisioning échoué :', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

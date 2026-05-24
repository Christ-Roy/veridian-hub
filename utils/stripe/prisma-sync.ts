// utils/stripe/prisma-sync.ts
//
// Helpers Prisma pour le webhook Stripe.
//
// Architecture post-refactor 2026-05-18 :
// - Stripe reste source de vérité pour l'ÉTAT des subscriptions (active/canceled,
//   trial_end, current_period_end). On sync ça dans `hub_app.subscriptions`.
// - Le CATALOGUE de plans vit dans lib/pricing/plans.ts (versionné). Plus de
//   table products/prices à maintenir — les fonctions upsert*/delete*
//   correspondantes ont été dégagées.
// - La mapping `stripe_price_id` → `PlanKey` passe par
//   getPlanByStripePriceId() qui regarde le catalogue ET le mapping legacy.

import Stripe from 'stripe';

import { prisma } from '@/lib/prisma';
import { stripe } from '@/utils/stripe/config';
import { toDateTime } from '@/utils/helpers';
import { getPlanByStripePriceId, getAppPlansForBundle } from '@/lib/pricing/helpers';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError, isNotifusePlan, type NotifusePlan } from '@/lib/notifuse/types';
import {
  computeWelcomeLeadsDelta,
  type ProspectionLocalPlan,
} from '@/lib/billing/refill-leads';
import { grantWelcomeLeadsBestEffort } from '@/utils/tenants/provision';

/**
 * Résultat de propagation Stripe → apps downstream, retourné par
 * `manageSubscriptionStatusChange`. Permet au dispatcher (lib/stripe/dispatcher.ts)
 * de décider s'il faut alerter Telegram.
 */
export interface PropagationResult {
  tenantId: string | null;
  /** Plans cibles appliqués (DB) — sert au log + dashboard admin. */
  applied: Array<{ app: 'notifuse' | 'prospection'; targetPlan: string; immune: boolean }>;
  /**
   * Apps downstream qui ont échoué après tous les retry HMAC du client. Si
   * non-vide → alerter Robert Telegram. Vide = tout est passé (ou app n'a pas
   * de propagation HMAC active comme Prospection au 2026-05-21).
   */
  failures: Array<{ app: 'notifuse' | 'prospection'; targetPlan: string; error: string }>;
}

/**
 * Résout le user UUID Hub lié à un Stripe customer ID.
 * Ordre :
 *  1. Existing Subscription avec ce stripeCustomerId
 *  2. Stripe customer metadata `userUuid` / `supabaseUUID` (legacy)
 *  3. Stripe customer email → User.supabaseUserId via lookup par email
 */
async function resolveUserUuid(customerId: string): Promise<string> {
  const existingSub = await prisma.subscription.findFirst({
    where: { stripeCustomerId: customerId },
    select: { userId: true },
  });
  if (existingSub?.userId) return existingSub.userId;

  const stripeCustomer = await stripe.customers.retrieve(customerId);
  if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
    throw new Error(`Stripe customer ${customerId} was deleted`);
  }

  const metadataUuid =
    (stripeCustomer.metadata?.userUuid as string | undefined) ??
    (stripeCustomer.metadata?.supabaseUUID as string | undefined) ??
    (stripeCustomer.metadata?.supabase_uuid as string | undefined);
  if (metadataUuid) return metadataUuid;

  const email = stripeCustomer.email;
  if (!email) {
    throw new Error(`Customer ${customerId} has no email and no metadata UUID`);
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { supabaseUserId: true },
  });
  if (!user?.supabaseUserId) {
    throw new Error(
      `Cannot resolve UUID for customer ${customerId} (email ${email}) — no User found`,
    );
  }
  return user.supabaseUserId;
}

/**
 * Sync de l'état Stripe → DB Hub pour une subscription, et propagation des
 * plans aux apps downstream concernées (notifuse, prospection) via le mapping
 * catalogue.
 *
 * Appelé par le webhook Stripe sur les events :
 *  - customer.subscription.created
 *  - customer.subscription.updated
 *  - customer.subscription.deleted
 *  - checkout.session.completed (via subscriptionId)
 */
export async function manageSubscriptionStatusChange(
  subscriptionId: string,
  customerId: string,
  _createAction = false,
  opts: { notifuseClient?: NotifuseClient } = {},
): Promise<PropagationResult> {
  const uuid = await resolveUserUuid(customerId);

  // Best-effort : on persiste le lien customer→user sur users si pas déjà fait.
  // Le lookup direct futur via `users.stripe_customer_id` court-circuite le
  // resolve en cascade et accélère le webhook.
  try {
    await prisma.user.updateMany({
      where: { supabaseUserId: uuid, stripeCustomerId: null },
      data: { stripeCustomerId: customerId },
    });
  } catch (err) {
    // Non-bloquant : si la colonne n'existe pas encore (migration pending),
    // on log et on continue.
    console.warn(
      `[stripe-sync] backfill users.stripe_customer_id failed (non-blocking):`,
      err instanceof Error ? err.message : err,
    );
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    // On expand le product du price pour pouvoir lire `metadata.veridian_plan`
    // posé par scripts/admin/setup-stripe-prices.ts — c'est la 3ᵉ source de
    // résolution du PlanKey, robuste même si le catalogue local n'a pas encore
    // le Price ID synchronisé.
    expand: ['default_payment_method', 'items.data.price.product'],
  });

  const priceObj = subscription.items.data[0]?.price ?? null;
  const stripePriceId = priceObj?.id ?? null;
  const isActive = ['active', 'trialing'].includes(subscription.status);

  // ─── Lookup PlanKey — 3 sources, par ordre de priorité ───
  // 1. metadata `plan_key` de la subscription, posée au checkout
  //    (cf app/api/billing/checkout/route.ts). Source explicite la plus sûre.
  // 2. metadata `veridian_plan` du Price / Product Stripe, posée par le
  //    script de provisioning. Survit même si le catalogue local n'a pas
  //    encore le Price ID (déploiements désynchronisés).
  // 3. mapping stripe_price_id → PlanKey via catalogue + LEGACY mapping.
  let planKey: string | null =
    (subscription.metadata?.plan_key as string | undefined) ?? null;

  if (!planKey && priceObj) {
    const priceMetaPlan = priceObj.metadata?.veridian_plan;
    const product = priceObj.product;
    const productMetaPlan =
      product && typeof product === 'object' && 'metadata' in product
        ? (product.metadata?.veridian_plan as string | undefined)
        : undefined;
    planKey = priceMetaPlan ?? productMetaPlan ?? null;
  }

  if (!planKey && stripePriceId) {
    const planFromPriceId = getPlanByStripePriceId(stripePriceId);
    if (planFromPriceId) {
      planKey = planFromPriceId.key;
    } else {
      console.warn(
        `[stripe-sync] Unknown stripe_price_id ${stripePriceId} for sub ${subscription.id} ` +
          `— add it to the catalogue or LEGACY_STRIPE_PRICE_MAPPING in lib/pricing/plans.ts`,
      );
    }
  }

  // ─── Sync subscription state ───
  const data = {
    userId: uuid,
    stripeCustomerId: subscription.customer as string,
    stripeSubscriptionId: subscription.id,
    stripePriceId,
    priceId: stripePriceId,
    status: subscription.status as
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'canceled'
      | 'incomplete'
      | 'incomplete_expired'
      | 'unpaid',
    metadata: (subscription.metadata ?? {}) as object,
    planName: planKey, // 🔥 Catalogue PlanKey, source de vérité côté Hub
    quantity:
      typeof (subscription as unknown as { quantity?: number }).quantity === 'number'
        ? (subscription as unknown as { quantity: number }).quantity
        : 1,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at ? toDateTime(subscription.cancel_at) : null,
    canceledAt: subscription.canceled_at ? toDateTime(subscription.canceled_at) : null,
    currentPeriodStart: toDateTime(subscription.current_period_start),
    currentPeriodEnd: toDateTime(subscription.current_period_end),
    created: toDateTime(subscription.created),
    endedAt: subscription.ended_at ? toDateTime(subscription.ended_at) : null,
    trialStart: subscription.trial_start ? toDateTime(subscription.trial_start) : null,
    trialEnd: subscription.trial_end ? toDateTime(subscription.trial_end) : null,
  };

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    create: data,
    update: data,
  });

  // ─── Propagation aux apps downstream via mapping catalogue ───
  // Cf docs/CONTRAT-HUB.md §7.4 (chaîne Stripe → Hub → apps).
  const result: PropagationResult = {
    tenantId: null,
    applied: [],
    failures: [],
  };

  if (!planKey) {
    return result;
  }

  let tenant: {
    id: string;
    notifuseWorkspaceSlug: string | null;
    notifusePlan: string | null;
    prospectionPlan: string | null;
    notifuseUserEmail: string | null;
    metadata: unknown;
  } | null = null;

  try {
    tenant = await prisma.tenant.findFirst({
      where: { userId: uuid },
      select: {
        id: true,
        notifuseWorkspaceSlug: true,
        notifusePlan: true,
        prospectionPlan: true,
        notifuseUserEmail: true,
        metadata: true,
      },
    });
  } catch (lookupErr) {
    console.error(
      `[stripe-sync] tenant lookup failed for user ${uuid} (non-blocking):`,
      lookupErr,
    );
    return result;
  }

  if (!tenant) {
    return result;
  }

  result.tenantId = tenant.id;

  // Plans actifs → applique le bundle. Inactifs → on retombe sur free.
  const appPlans = isActive
    ? getAppPlansForBundle(planKey as Parameters<typeof getAppPlansForBundle>[0])
    : [];

  // Default conservateur : si subscription inactive, downgrade aux plans free.
  // ATTENTION : ne JAMAIS toucher un tenant avec plan_source ∈ lifetime_*/internal
  // (cf §3.3 contrat — immunité Stripe).
  const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
  const notifusePlanSource =
    (meta.notifuse_plan_source as string | undefined) ?? 'manual';
  const isImmuneNotifuse = ['lifetime_site_vitrine', 'lifetime_partner', 'internal'].includes(
    notifusePlanSource,
  );

  const targetNotifuse = isImmuneNotifuse
    ? tenant.notifusePlan ?? 'free'
    : isActive
      ? appPlans.find((p) => p.app === 'notifuse')?.plan?.replace(/^notifuse-/, '') ?? 'free'
      : 'free';

  const targetProspection = isActive
    ? appPlans.find((p) => p.app === 'prospection')?.plan?.replace(/^prospection-/, '') ?? 'freemium'
    : 'freemium';

  // ─── 1. Sync DB Hub (source de vérité côté Hub) ───
  try {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        notifusePlan: targetNotifuse,
        prospectionPlan: targetProspection,
      },
    });
  } catch (dbErr) {
    console.error(
      `[stripe-sync] tenant.update failed for ${tenant.id}:`,
      dbErr,
    );
    return result;
  }

  result.applied.push({ app: 'notifuse', targetPlan: targetNotifuse, immune: isImmuneNotifuse });
  result.applied.push({ app: 'prospection', targetPlan: targetProspection, immune: false });

  console.log(
    `[stripe-sync] Tenant ${tenant.id} updated: notifuse=${targetNotifuse}, prospection=${targetProspection} ` +
      `(planKey=${planKey}, isActive=${isActive}, immune=${isImmuneNotifuse})`,
  );

  // ─── 1ter. Purge tenant_trials → converted (anti-résidus trial) ───
  // Cf docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md + ticket
  // 2026-05-23-audit-trial-residus-apres-paiement.md.
  //
  // Quand la subscription Stripe devient active, on bascule TOUTES les lignes
  // tenant_trials non-terminales du tenant à `converted`. Sinon :
  //   - le cron `processEndingSoon` enverrait quand même le mail "expire dans 3j"
  //     au user qui paie déjà (faille majeure trouvée 2026-05-24)
  //   - le bandeau FreemiumBanner est gated par `hasActiveSubscription` côté
  //     layout donc OK en surface, mais la DB reste sale → drift detection
  //     bruyante + risque de régression UI future si on retire le gate
  //
  // Idempotent : si la ligne est déjà `converted` ou `expired`, le WHERE
  // exclut. Pas d'erreur si aucune ligne n'existe (cas user qui s'abonne
  // avant d'avoir déclenché le trial threshold).
  if (isActive) {
    try {
      const converted = await prisma.tenantTrial.updateMany({
        where: {
          tenantId: tenant.id,
          state: { in: ['eligible', 'trial_active', 'trial_ending_soon'] },
        },
        data: { state: 'converted', updatedAt: new Date() },
      });
      if (converted.count > 0) {
        console.log(
          `[stripe-sync] Purged ${converted.count} trial row(s) → converted ` +
            `for tenant=${tenant.id} (sub active)`,
        );
      }
    } catch (trialErr) {
      // Non-bloquant : la propagation downstream + welcome leads doit continuer.
      // Cas le pire = le cron processFinalize finira par marquer converted
      // quand trial_ends_at <= NOW (sub active détectée → state=converted).
      console.error(
        `[stripe-sync] tenant_trials purge → converted failed (non-blocking) for ${tenant.id}:`,
        trialErr instanceof Error ? trialErr.message : trialErr,
      );
    }
  }

  // ─── 1bis. Welcome leads sur UPGRADE Prospection ───
  // Si le palier Prospection augmente (free → pro → business), on crédite le
  // DELTA de welcome leads (cf PRICING-VERIDIAN.md §78 + §97). Downgrade =
  // pas d'appel (leads permanents). Idempotency_key déterministe (tenant +
  // welcome_plan) → l'invariant "1 welcome par palier" est tenu côté
  // Prospection même si on rejoue.
  //
  // On utilise l'email owner comme tenantIdOrEmail (résolution dual côté
  // Prospection). Fallback : si email non en DB, on tente le tenantId.
  if (isActive && isValidProspectionLocalPlan(targetProspection)) {
    const oldPlan = isValidProspectionLocalPlan(tenant.prospectionPlan)
      ? (tenant.prospectionPlan as ProspectionLocalPlan)
      : null;
    const delta = computeWelcomeLeadsDelta(oldPlan, targetProspection);
    if (delta > 0) {
      const ownerEmail = tenant.notifuseUserEmail;
      if (ownerEmail) {
        const welcomeRes = await grantWelcomeLeadsBestEffort({
          hubTenantId: tenant.id,
          ownerEmail,
          welcomePlan: targetProspection,
          quantityOverride: delta,
        });
        if (!welcomeRes.success) {
          console.warn(
            `[stripe-sync] welcome leads delta=${delta} grant failed (non-blocking) ` +
              `tenant=${tenant.id} plan=${targetProspection} err=${welcomeRes.error}`,
          );
        } else {
          console.log(
            `[stripe-sync] welcome leads delta=${delta} credited tenant=${tenant.id} ` +
              `plan=${targetProspection}`,
          );
        }
      } else {
        console.warn(
          `[stripe-sync] welcome leads delta=${delta} skip — no owner email on tenant ${tenant.id}`,
        );
      }
    }
  }

  // ─── 2. Propagation HMAC Hub → Notifuse (§7.4) ───
  // Si l'app a son workspace provisionné. Si immune → on skip (le tenant ne
  // doit pas être bougé par Stripe).
  if (!isImmuneNotifuse && tenant.notifuseWorkspaceSlug) {
    const client = opts.notifuseClient ?? buildDefaultNotifuseClient();
    if (client) {
      // Cast safe — targetNotifuse vient de getAppPlansForBundle qui mappe
      // toujours sur des plans valides Notifuse. Si jamais une nouvelle valeur
      // apparaît côté catalogue sans être ajoutée au union NotifusePlan, on
      // log un warning et on n'appelle pas l'app downstream.
      if (!isNotifusePlan(targetNotifuse)) {
        const msg = `targetNotifuse "${targetNotifuse}" non reconnu côté Notifuse, propagation HMAC skip`;
        console.warn(`[stripe-sync] ${msg} tenant=${tenant.id}`);
        result.failures.push({ app: 'notifuse', targetPlan: targetNotifuse, error: msg });
        return result;
      }
      const safePlan: NotifusePlan = targetNotifuse;
      try {
        await client.updatePlan({
          tenantId: tenant.id,
          plan: safePlan,
        });
        console.log(
          `[stripe-sync] HMAC update-plan OK notifuse tenant=${tenant.id} plan=${targetNotifuse}`,
        );
      } catch (hmacErr) {
        const message =
          hmacErr instanceof NotifuseError
            ? `Notifuse HTTP ${hmacErr.code}: ${hmacErr.message}`
            : hmacErr instanceof Error
              ? hmacErr.message
              : String(hmacErr);
        console.error(
          `[stripe-sync] HMAC update-plan KO notifuse tenant=${tenant.id} plan=${targetNotifuse}: ${message}`,
        );
        result.failures.push({ app: 'notifuse', targetPlan: targetNotifuse, error: message });
      }
    } else {
      console.warn(
        `[stripe-sync] Notifuse client not configured (ENV manquant) — propagation HMAC skip pour ${tenant.id}`,
      );
    }
  }

  // Prospection : pas encore d'endpoint update-plan câblé côté agent
  // Prospection au 2026-05-21 (ticket dispatché). DB Hub mise à jour ci-dessus,
  // l'app le lira via discovery quand son endpoint sera prêt.

  return result;
}

/**
 * Construit le client Notifuse depuis ENV. Renvoie null si ENV manquant
 * (cas dev local sans Notifuse câblé). Le dispatcher gère le null en logguant.
 */
function buildDefaultNotifuseClient(): NotifuseClient | null {
  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl || !hubSecret) return null;
  return new NotifuseClient({ apiUrl, hubSecret });
}

/** Type-guard pour le plan local Prospection (BDD stocke des strings libres). */
function isValidProspectionLocalPlan(
  value: string | null | undefined,
): value is ProspectionLocalPlan {
  return value === 'freemium' || value === 'pro' || value === 'business';
}

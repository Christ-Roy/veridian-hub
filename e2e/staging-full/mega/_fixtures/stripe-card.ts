/**
 * MEGA fixture — `stripe-card.ts`
 *
 * Wrappers Playwright pour interagir avec Stripe Checkout en mode TEST :
 *   - remplir une carte test (4242, 3DS, decline)
 *   - naviguer Customer Portal pour cancel/reactivate sub
 *   - ajouter/retirer une payment method
 *
 * **POURQUOI** : tous les buckets C, D, E (billing checkout, plan changes,
 * refill leads) font du Stripe Checkout. Plutôt que de réécrire 20× la
 * séquence "wait input → fill 4242 → fill exp → fill cvc → click submit",
 * on factorise ici une API claire :
 *
 *   await fillStripeCheckout(page, { card: 'success' });
 *   // ou : await fillStripeCheckout(page, { card: '3ds-required' });
 *   // ou : await fillStripeCheckout(page, { card: 'decline' });
 *
 * **CARTES TEST STRIPE** (https://stripe.com/docs/testing#cards) :
 *   - 4242 4242 4242 4242 : succès immédiat
 *   - 4000 0025 0000 3155 : 3DS authentification requise (succès si confirm)
 *   - 4000 0000 0000 0002 : decline (carte refusée)
 *   - 4000 0000 0000 9995 : insufficient funds
 *
 * **PIÈGE** : Stripe Checkout iframe les inputs CB. Playwright accède
 * via `frameLocator('iframe[name*="card-element"]')`. Le nom de
 * l'iframe peut varier selon le mode (embedded vs hosted) — on tente
 * les 2 patterns connus.
 */
import { expect, type Page } from '@playwright/test';

export type StripeTestCard = 'success' | '3ds-required' | 'decline' | 'insufficient-funds';

const CARDS: Record<StripeTestCard, string> = {
  'success': '4242424242424242',
  '3ds-required': '4000002500003155',
  'decline': '4000000000000002',
  'insufficient-funds': '4000000000009995',
};

export interface FillStripeCheckoutOpts {
  /** Type de carte test à utiliser. Défaut `success`. */
  card?: StripeTestCard;
  /** Nom titulaire. Défaut `E2E Mega Test`. */
  cardholder?: string;
  /** Date d'expiration MM/YY. Défaut `12/30`. */
  expiry?: string;
  /** CVC. Défaut `123`. */
  cvc?: string;
  /** Code postal (pour US/FR). Défaut `75001` (Paris 1er). */
  postalCode?: string;
  /** Timeout pour attendre l'apparition du form. Défaut 20s. */
  timeout?: number;
}

/**
 * Remplit le formulaire Stripe Checkout avec une carte test et soumet.
 *
 * **Attention** : Stripe Checkout est un domaine externe
 * (`checkout.stripe.com`). Playwright suit le redirect, mais le `page`
 * passé en argument est le même contexte navigateur. Aucune restriction
 * cross-origin pour l'automation.
 *
 * **Retour** : URL de redirect post-succès (typiquement
 * `<STAGING_URL>/dashboard?session_id=cs_test_...`).
 */
export async function fillStripeCheckout(
  page: Page,
  opts: FillStripeCheckoutOpts = {},
): Promise<string> {
  const cardType = opts.card ?? 'success';
  const cardNumber = CARDS[cardType];
  const cardholder = opts.cardholder ?? 'E2E Mega Test';
  const expiry = opts.expiry ?? '1230'; // MMYY sans /
  const cvc = opts.cvc ?? '123';
  const postalCode = opts.postalCode ?? '75001';
  const timeout = opts.timeout ?? 20_000;

  // ─── 1. Attendre que le form Stripe Checkout charge ────────────────
  // Stripe Checkout v3 utilise des inputs natifs (pas d'iframe) pour
  // hosted checkout. Les sélecteurs sont stables :
  await page.waitForURL(/checkout\.stripe\.com/, { timeout });

  // L'input `cardNumber` peut s'appeler `cardNumber` (hosted) ou être
  // dans une iframe Elements (embedded). On tente hosted d'abord.
  const numberLocator = page.locator('input[name="cardNumber"], input#cardNumber');
  await numberLocator.waitFor({ state: 'visible', timeout });

  // ─── 2. Remplir les champs ─────────────────────────────────────────
  await numberLocator.fill(cardNumber);

  const expiryLocator = page.locator('input[name="cardExpiry"], input#cardExpiry');
  await expiryLocator.fill(expiry);

  const cvcLocator = page.locator('input[name="cardCvc"], input#cardCvc');
  await cvcLocator.fill(cvc);

  const nameLocator = page.locator('input[name="billingName"], input#billingName');
  if (await nameLocator.isVisible().catch(() => false)) {
    await nameLocator.fill(cardholder);
  }

  const postalLocator = page.locator(
    'input[name="billingPostalCode"], input#billingPostalCode',
  );
  if (await postalLocator.isVisible().catch(() => false)) {
    await postalLocator.fill(postalCode);
  }

  // ─── 3. Submit ─────────────────────────────────────────────────────
  // Le bouton submit Stripe Checkout a un sélecteur stable
  // `button[type="submit"]` (souvent texte "Pay" ou "Subscribe").
  const submitButton = page.locator('button[type="submit"]').first();
  await submitButton.click();

  // ─── 4. Attendre redirect ──────────────────────────────────────────
  // En cas de carte 3DS, Stripe affiche une modale à confirmer.
  // En cas de decline, on reste sur la page checkout avec erreur.
  if (cardType === '3ds-required') {
    // 3DS modal : cliquer "Complete authentication"
    const completeAuth = page.locator(
      'button:has-text("Complete authentication"), button:has-text("Complete")',
    );
    await completeAuth.click({ timeout: 15_000 });
  }

  // Wait redirect vers la URL de succès (callback Hub)
  await page.waitForURL((url) => !url.toString().includes('checkout.stripe.com'), {
    timeout: 30_000,
  });

  return page.url();
}

/**
 * Vérifie qu'une page Stripe Checkout affiche bien une erreur (decline,
 * insufficient_funds). À appeler après `fillStripeCheckout(..., {card:
 * 'decline'})`.
 */
export async function expectStripeCheckoutError(page: Page): Promise<void> {
  // L'erreur Stripe Checkout apparaît dans un div role="alert" ou
  // contient le mot "declined" / "refused" / "insufficient".
  const errorLocator = page.locator(
    '[role="alert"], text=/declin|refused|insufficient|failed/i',
  );
  await expect(errorLocator.first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Navigue le Customer Portal Stripe (créé par Hub via
 * `/api/billing/portal`) et cancel la subscription active.
 *
 * Pré-requis : la `page` est déjà sur l'URL du Customer Portal Stripe.
 *
 * Retour : URL de retour (return_url configurée côté Hub).
 */
export async function cancelSubscriptionInPortal(page: Page): Promise<string> {
  await page.waitForURL(/billing\.stripe\.com/, { timeout: 20_000 });

  // Cliquer "Cancel subscription"
  await page.locator('text=/cancel.*subscription/i').first().click();

  // Confirmer dans le modal
  await page.locator('button:has-text("Cancel subscription")').last().click();

  // Attendre le retour vers Hub
  await page.waitForURL((url) => !url.toString().includes('billing.stripe.com'), {
    timeout: 20_000,
  });

  return page.url();
}

/**
 * Liste des cartes test disponibles (utile pour parametrized tests).
 */
export const STRIPE_TEST_CARDS = CARDS;

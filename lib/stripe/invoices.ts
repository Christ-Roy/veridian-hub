/**
 * Lecture des factures Stripe récentes d'un Customer pour affichage inline
 * dans `/dashboard/billing`.
 *
 * Server-side uniquement (utilise `stripe.invoices.list` avec la clé secrète).
 * Renvoie une vue sérialisée (montant, date, statut, URL PDF hosted) prête
 * à être consommée par un Server Component.
 *
 * Spec : tâche #24 SPEC #4 "Refonte billing — additions ciblées" §A.
 */

import { stripe } from '@/utils/stripe/config';

/**
 * Vue sérialisée d'une facture Stripe pour l'UI.
 *
 *  - `id`        : Stripe invoice id (`in_…`)
 *  - `number`    : ex. "INV-2026-00042" — null possible (draft jamais finalisé)
 *  - `createdAt` : ISO string (déjà sérialisé pour le client)
 *  - `amountPaid`: cents (Stripe stocke en cents — pas de conversion ici,
 *                  la responsabilité de format Euro est à l'UI)
 *  - `currency`  : "eur" / "usd" lowercase
 *  - `status`    : 'paid' | 'open' | 'void' | 'draft' | 'uncollectible'
 *  - `hostedInvoiceUrl` : lien Stripe-hosted que l'user peut ouvrir sans auth
 *                          (PDF disponible via bouton sur la page). NE PAS confondre
 *                          avec `invoice_pdf` qui exige une session Stripe.
 */
export type InvoiceView = {
  id: string;
  number: string | null;
  createdAt: string;
  amountPaid: number;
  currency: string;
  status: string;
  hostedInvoiceUrl: string | null;
};

/**
 * Récupère les N dernières factures d'un Customer Stripe.
 *
 * @param stripeCustomerId  ID Stripe Customer (cu_…), null-tolérant pour
 *                          les users sans Customer encore créé (renvoie []).
 * @param limit             Max 100 imposé par Stripe. Default 3.
 */
export async function getRecentInvoices(
  stripeCustomerId: string | null,
  limit = 3,
): Promise<InvoiceView[]> {
  if (!stripeCustomerId) return [];

  const safeLimit = Math.min(Math.max(limit, 1), 100);

  try {
    const list = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: safeLimit,
    });

    return list.data.map((inv) => ({
      id: inv.id,
      number: inv.number ?? null,
      // Stripe renvoie un timestamp Unix (secondes) → ISO 8601 pour l'UI.
      createdAt: new Date(inv.created * 1000).toISOString(),
      amountPaid: inv.amount_paid,
      currency: inv.currency,
      status: inv.status ?? 'draft',
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    }));
  } catch (err) {
    // Best-effort : un échec API Stripe ne doit pas bloquer toute la page
    // billing. L'UI rendra simplement un état vide (sans liste).
    console.error('[stripe/invoices] getRecentInvoices failed:', err);
    return [];
  }
}

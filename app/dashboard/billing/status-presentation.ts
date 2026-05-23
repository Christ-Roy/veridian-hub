/**
 * Présentation des états de subscription Stripe sur la page billing.
 *
 * Module pur (zéro JSX, zéro dépendance React) : mappe un `SubscriptionStatus`
 * Stripe sur ce que l'UI doit montrer (badge, alerte de tête de page). Isolé
 * pour rester testable sans rendu et pour que la page reste un simple câblage.
 *
 * ⚠️ Ce module est de l'UI d'affichage. Toute la logique Stripe (webhook,
 * checkout, portal) appartient à `lib/stripe/` / `app/api/billing/` — ne pas
 * la dupliquer ici.
 */

/** Statuts Stripe synchronisés par le webhook orchestrator (enum Prisma). */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

/** Variant sémantique du Badge shadcn (tokens OKLCH, jamais de couleur brute). */
export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'
  | 'info';

/** Variant de l'Alert shadcn. */
export type AlertVariant = 'default' | 'destructive' | 'success' | 'warning' | 'info';

/** Tonalité d'une alerte de tête de page liée à l'état de la subscription. */
export interface StatusAlert {
  variant: AlertVariant;
  /** Titre court de l'alerte. */
  title: string;
  /** Phrase d'explication, ton non-anxiogène. */
  description: string;
  /**
   * Action attendue. `portal` = ouvrir le Stripe Portal (mettre à jour la
   * carte / réactiver), `pricing` = renvoyer vers la grille tarifaire.
   */
  cta: 'portal' | 'pricing';
  /** Libellé du bouton d'action. */
  ctaLabel: string;
}

interface StatusBadge {
  label: string;
  variant: BadgeVariant;
}

const BADGE_BY_STATUS: Record<SubscriptionStatus, StatusBadge> = {
  active: { label: 'Actif', variant: 'success' },
  trialing: { label: 'Essai en cours', variant: 'info' },
  past_due: { label: 'Paiement en échec', variant: 'warning' },
  canceled: { label: 'Annulé', variant: 'outline' },
  incomplete: { label: 'Incomplet', variant: 'outline' },
  incomplete_expired: { label: 'Expiré', variant: 'outline' },
  unpaid: { label: 'Impayé', variant: 'destructive' },
};

/**
 * Badge à afficher à côté du plan courant. Tout statut inconnu retombe sur
 * "Incomplet" — fail-safe, jamais de badge vide.
 */
export function getStatusBadge(status: string): StatusBadge {
  return BADGE_BY_STATUS[status as SubscriptionStatus] ?? BADGE_BY_STATUS.incomplete;
}

/**
 * Alerte de tête de page selon l'état de la subscription, ou `null` quand
 * l'état ne demande aucune action (`active`, `trialing`, `incomplete`).
 *
 * - `past_due` / `unpaid` → alerte d'urgence : un défaut de paiement non
 *   rattrapé fait churner le client, c'est le point critique du ticket.
 * - `canceled` / `incomplete_expired` → invitation à réactiver, ton neutre.
 */
export function getStatusAlert(status: string): StatusAlert | null {
  switch (status as SubscriptionStatus) {
    case 'past_due':
    case 'unpaid':
      return {
        variant: 'destructive',
        title: 'Ton dernier paiement a échoué',
        description:
          'Mets à jour ta carte bancaire pour éviter la suspension de ton abonnement. Aucune coupure tant que tu régularises.',
        cta: 'portal',
        ctaLabel: 'Mettre à jour ma carte',
      };
    case 'canceled':
    case 'incomplete_expired':
      return {
        variant: 'warning',
        title: 'Ton abonnement est annulé',
        description:
          'Tu peux le réactiver à tout moment pour retrouver toutes les fonctionnalités.',
        cta: 'pricing',
        ctaLabel: 'Réactiver mon abonnement',
      };
    default:
      return null;
  }
}

/**
 * Vrai si l'utilisateur conserve un accès opérationnel à l'app pour ce
 * statut (utilisé pour le ton de la carte plan, pas pour gater l'accès —
 * le gating réel vit côté apps via `/api/limits`).
 */
export function hasUsableAccess(status: string): boolean {
  return ['trialing', 'active', 'past_due'].includes(status);
}

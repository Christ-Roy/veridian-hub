/**
 * Typage minimal de la librairie Google Identity Services (GSI), chargée
 * dynamiquement depuis `https://accounts.google.com/gsi/client`.
 *
 * On ne couvre QUE la surface utilisée par le widget One Tap
 * (`components/auth/GoogleOneTap.tsx`). La lib n'expose pas de package npm
 * `@types/*` officiel — ce fichier tient lieu de contrat local.
 *
 * Réf : https://developers.google.com/identity/gsi/web/reference/js-reference
 */

/** Credential renvoyé au callback One Tap après un tap utilisateur. */
interface GoogleCredentialResponse {
  /** `id_token` JWT signé par Google. À valider serveur-side. */
  credential: string;
  /** Comment la sélection s'est faite (`auto` = auto-select, etc.). */
  select_by?: string;
}

/** Notification émise par `prompt()` sur le cycle de vie de la popup. */
interface GooglePromptNotification {
  isDisplayMoment(): boolean;
  isDisplayed(): boolean;
  isNotDisplayed(): boolean;
  getNotDisplayedReason(): string;
  isSkippedMoment(): boolean;
  getSkippedReason(): string;
  isDismissedMoment(): boolean;
  getDismissedReason(): string;
  getMomentType(): string;
}

/** Config passée à `google.accounts.id.initialize()`. */
interface GoogleIdConfiguration {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
  /** Affiche automatiquement la popup pour le compte le plus récent. */
  auto_select?: boolean;
  /** Support du Intelligent Tracking Prevention (Safari / iOS). */
  itp_support?: boolean;
  /** Si false, la popup reste affichée même au clic en dehors. */
  cancel_on_tap_outside?: boolean;
  /**
   * Active l'API navigateur FedCM pour le prompt One Tap. OBLIGATOIRE
   * depuis fin 2024 : Chrome ne rend plus le prompt One Tap legacy
   * (cookies tiers dépréciés). Sans ce flag, One Tap ne s'affiche pas.
   */
  use_fedcm_for_prompt?: boolean;
  /** Contexte d'usage — adapte le wording de la popup. */
  context?: 'signin' | 'signup' | 'use';
  /** Mode UX — 'popup' (défaut) ou 'redirect'. */
  ux_mode?: 'popup' | 'redirect';
}

interface GoogleAccountsId {
  initialize(config: GoogleIdConfiguration): void;
  /** Affiche la popup One Tap. Le callback observe le cycle de vie. */
  prompt(listener?: (notification: GooglePromptNotification) => void): void;
  /** Annule un prompt One Tap en cours d'affichage. */
  cancel(): void;
  /** Désactive l'auto-select après un sign-out (RGPD / UX). */
  disableAutoSelect(): void;
}

interface GoogleAccounts {
  id: GoogleAccountsId;
}

interface Window {
  google?: {
    accounts: GoogleAccounts;
  };
}

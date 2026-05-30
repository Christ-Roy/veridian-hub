'use client';

/**
 * Google One Tap — popup d'auto-login Google affichée en haut-droite pour
 * les visiteurs non-loggués.
 *
 * Charge la librairie Google Identity Services (GSI), initialise le widget
 * One Tap, et au tap utilisateur valide le `id_token` via le provider
 * Auth.js `google-one-tap` (cf. lib/auth/google-one-tap-provider.ts).
 *
 * GARDE-FOUS (ticket todo/2026-05-20-google-one-tap-landing-pages.md) :
 *  - Ne render QUE si l'utilisateur est non-loggué (`useSession()` →
 *    `unauthenticated`). En `loading` ou `authenticated` : rien.
 *  - Désactivé sur staging — pas de client_id exposé (cohérent avec
 *    `allowOauth` côté serveur, privatisation Tailscale). Le widget ne
 *    s'initialise pas si `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` est vide.
 *  - Désactivé sur les pages MFA (`/auth/mfa`) : un user en train de saisir
 *    son code 2FA ne doit pas voir une popup qui relancerait un sign-in.
 *  - `auto_select` respecte le cooldown natif Google "Don't show again"
 *    (24h après un Cancel) — géré côté GSI, on ne le contourne pas.
 *  - `itp_support` activé pour Safari / iOS (Intelligent Tracking
 *    Prevention).
 *
 * Note : ce composant ne rend aucun markup visible — la popup est injectée
 * par GSI dans son propre conteneur. Il retourne `null`.
 */

import { useCallback, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useSession, signIn } from 'next-auth/react';
import { useEnv } from '@/contexts/EnvContext';

const GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const GSI_SCRIPT_ID = 'google-gsi-client';

/**
 * Préfixes de chemins où One Tap NE doit PAS s'afficher, même pour un user
 * non-loggué. `/auth/mfa` : pré-session MFA — afficher One Tap court-
 * circuiterait le 2FA en cours.
 */
const ONE_TAP_BLOCKED_PREFIXES = ['/auth/mfa'];

/** True si le pathname courant interdit l'affichage de One Tap. */
export function isOneTapBlockedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return ONE_TAP_BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export interface GoogleOneTapProps {
  /**
   * URL de redirection après un sign-in One Tap réussi.
   * Défaut : `/dashboard`.
   */
  callbackUrl?: string;
  /**
   * Contexte d'usage GSI — adapte le wording de la popup ("Se connecter"
   * vs "S'inscrire"). Défaut : `signin`.
   */
  context?: 'signin' | 'signup' | 'use';
}

export function GoogleOneTap({
  callbackUrl = '/dashboard',
  context = 'signin',
}: GoogleOneTapProps) {
  const { status } = useSession();
  const pathname = usePathname();
  const { NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: clientId } = useEnv();

  // Empêche une double-initialisation GSI (StrictMode double-mount en dev,
  // re-render sur changement de session).
  const initializedRef = useRef(false);

  /**
   * Callback invoqué par GSI quand l'utilisateur tape la popup.
   * Transmet le `id_token` au provider Auth.js `google-one-tap`, qui le
   * valide serveur-side puis déroule le flow normal (hook MFA inclus).
   */
  const handleCredentialResponse = useCallback(
    (response: GoogleCredentialResponse) => {
      if (!response?.credential) return;
      void signIn('google-one-tap', {
        credential: response.credential,
        callbackUrl,
      });
    },
    [callbackUrl],
  );

  // Conditions d'activation. On les évalue avant tout effet réseau pour ne
  // jamais charger le script GSI inutilement.
  const shouldRender =
    status === 'unauthenticated' &&
    !!clientId &&
    !isOneTapBlockedPath(pathname);

  useEffect(() => {
    if (!shouldRender) return;
    if (initializedRef.current) return;

    let cancelled = false;

    /** Initialise le widget One Tap une fois GSI chargé. */
    const initOneTap = () => {
      if (cancelled) return;
      const gsi = window.google?.accounts?.id;
      if (!gsi) return;

      initializedRef.current = true;
      gsi.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        // FedCM obligatoire : depuis fin 2024 Google migre One Tap vers
        // l'API navigateur FedCM et Chrome NE REND PLUS le prompt legacy
        // (cookies tiers dépréciés). Sans ce flag, One Tap ne s'affiche
        // tout simplement plus sur Chrome récent — bug constaté prod
        // 2026-05-30 (warning GSI_LOGGER FedCM migration). Réf :
        // developers.google.com/identity/gsi/web/guides/fedcm-migration
        use_fedcm_for_prompt: true,
        // Auto-select : affiche directement le compte le plus récent.
        // Le cooldown "Don't show again" (24h) reste géré par GSI.
        auto_select: true,
        // Intelligent Tracking Prevention — requis pour Safari / iOS.
        itp_support: true,
        // La popup reste affichée si l'user clique en dehors : moins
        // agressif qu'une fermeture au moindre clic accidentel.
        // NB : sous FedCM, la fermeture est gérée par l'UI navigateur ;
        // ce flag reste sans effet négatif (ignoré en mode FedCM).
        cancel_on_tap_outside: false,
        context,
      });
      gsi.prompt();
    };

    // Le script GSI peut déjà être présent (navigation client interne) —
    // dans ce cas on initialise direct, sinon on l'injecte une fois.
    const existing = document.getElementById(GSI_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if (window.google?.accounts?.id) {
        initOneTap();
      } else {
        existing.addEventListener('load', initOneTap, { once: true });
      }
    } else {
      const script = document.createElement('script');
      script.id = GSI_SCRIPT_ID;
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', initOneTap, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      // Ferme la popup si l'utilisateur quitte la page / se logge entre-temps.
      window.google?.accounts?.id?.cancel();
    };
  }, [shouldRender, clientId, context, handleCredentialResponse]);

  // Aucun markup : GSI injecte sa propre popup dans le DOM.
  return null;
}

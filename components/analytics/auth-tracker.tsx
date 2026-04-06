'use client';

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { trackSignUp, trackLogin, setUserId, trackError } from '@/lib/gtm';
import { createClient } from '@/utils/supabase/client';

/**
 * AuthTracker - Composant qui track les événements d'authentification
 *
 * Ce composant :
 * 1. Track automatiquement signup/login quand l'utilisateur arrive sur le dashboard
 * 2. Set le user_id pour le cross-device tracking
 * 3. Track les erreurs d'authentification
 *
 * À placer dans le layout du dashboard ou des pages protégées
 */
export function AuthTracker() {
  const searchParams = useSearchParams();
  const hasTracked = useRef(false);

  useEffect(() => {
    // Ne track qu'une seule fois par session
    if (hasTracked.current) return;

    const trackAuth = async () => {
      const supabase = createClient();
      const { data: { user }, error } = await supabase.auth.getUser();

      if (error) {
        console.error('[AuthTracker] Error getting user:', error);
        trackError('auth_error', error.message);
        return;
      }

      if (!user) {
        console.log('[AuthTracker] No user found');
        return;
      }

      // Set user ID for cross-device tracking
      setUserId(user.id);
      console.log('[AuthTracker] User ID set:', user.id);

      // Vérifier si c'est un nouveau signup (created_at récent)
      const userCreatedAt = new Date(user.created_at);
      const now = new Date();
      const diffMinutes = (now.getTime() - userCreatedAt.getTime()) / 1000 / 60;

      // Si le compte a été créé il y a moins de 5 minutes, c'est probablement un signup
      const isNewUser = diffMinutes < 5;

      // Détecter la méthode d'auth depuis les metadatas ou le provider
      const provider = user.app_metadata?.provider || 'email';
      const method = provider === 'github' ? 'google' : 'email'; // Adapter selon vos providers

      if (isNewUser) {
        console.log('[AuthTracker] Tracking sign_up event, method:', method);
        trackSignUp(method);
      } else {
        console.log('[AuthTracker] Tracking login event, method:', method);
        trackLogin(method);
      }

      hasTracked.current = true;
    };

    // Petit délai pour s'assurer que la session est bien établie
    const timer = setTimeout(trackAuth, 500);

    return () => clearTimeout(timer);
  }, [searchParams]);

  // Ce composant ne rend rien
  return null;
}

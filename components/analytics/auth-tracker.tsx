'use client';

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { trackSignUp, trackLogin, setUserId } from '@/lib/gtm';

/**
 * AuthTracker — Auth.js v5
 *
 * Track signup/login events vers GA4 quand l'utilisateur arrive sur le
 * dashboard. Utilise `useSession()` côté client.
 *
 * Heuristique "nouveau signup vs login" : on n'a pas l'info created_at depuis
 * le JWT côté client. On s'appuie sur le query param `event` (`?event=signup`)
 * qui peut être ajouté par le flow signup. Sinon, par défaut, on track `login`.
 */
export function AuthTracker() {
  const { data: session, status } = useSession();
  const searchParams = useSearchParams();
  const hasTracked = useRef(false);

  useEffect(() => {
    if (hasTracked.current) return;
    if (status !== 'authenticated' || !session?.user?.id) return;

    setUserId(session.user.id);

    const eventParam = searchParams?.get('event');
    const provider = searchParams?.get('provider') || 'email';
    const method = provider === 'google' ? 'google' : 'email';

    if (eventParam === 'signup') {
      trackSignUp(method);
    } else {
      trackLogin(method);
    }

    hasTracked.current = true;
  }, [session, status, searchParams]);

  return null;
}

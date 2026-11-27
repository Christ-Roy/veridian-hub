'use client';

import { signOut } from 'next-auth/react';

export function ChangerDeCompte() {
  return (
    <button type="button" className="inline-flex min-h-11 items-center underline" onClick={() => void signOut({ callbackUrl: '/login?normal=1' })}>
      Changer de compte
    </button>
  );
}

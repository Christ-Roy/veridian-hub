/**
 * Tests de la home `/` (app/(marketing)/page.tsx) — devenue une simple
 * redirection (le marketing vit sur veridian.site depuis 2026-05-29).
 *
 * Contrat vérifié :
 *  - user loggué      → redirect('/dashboard') (jamais éjecté vers marketing)
 *  - user non-loggué  → redirect(URL marketing) via resolveMarketingUrl
 *  - cible marketing configurable par ENV MARKETING_URL
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getCurrentUserMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  // Le vrai redirect() de Next throw pour interrompre le render. On reproduit
  // ce comportement pour que le flux de contrôle de la page soit fidèle.
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}));

import HomePage from '@/app/(marketing)/page';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('HomePage `/` — redirection', () => {
  it('user loggué → redirect /dashboard', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u1',
      email: 'robert@veridian.site',
      name: 'Robert',
      image: null,
      supabaseUserId: 'uuid-1',
    });

    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
  });

  it('user non-loggué → redirect vers le marketing (défaut racine veridian.site)', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    delete process.env.MARKETING_URL;

    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT:https://veridian.site');
    expect(redirectMock).toHaveBeenCalledWith('https://veridian.site');
  });

  it('user non-loggué → respecte MARKETING_URL (bascule page produit dédiée)', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    process.env.MARKETING_URL = 'https://veridian.site/plateforme';

    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT:https://veridian.site/plateforme');
    expect(redirectMock).toHaveBeenCalledWith('https://veridian.site/plateforme');
  });

  it('ne redirige PAS un user loggué vers le marketing même si MARKETING_URL posée', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u2',
      email: 'client@example.com',
      name: null,
      image: null,
      supabaseUserId: 'uuid-2',
    });
    process.env.MARKETING_URL = 'https://veridian.site/plateforme';

    await expect(HomePage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
    expect(redirectMock).not.toHaveBeenCalledWith('https://veridian.site/plateforme');
  });
});

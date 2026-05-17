/**
 * Test smoke pour GET /api/config après removal Twenty (2026-05-18).
 *
 * Vérifie que la response :
 *   1. Ne contient PAS NEXT_PUBLIC_TWENTY_URL.
 *   2. Contient NEXT_PUBLIC_NOTIFUSE_URL, NEXT_PUBLIC_SITE_URL, etc.
 */

import { describe, it, expect } from 'vitest';

describe('GET /api/config', () => {
  it('does not expose NEXT_PUBLIC_TWENTY_URL', async () => {
    const { GET } = await import('@/app/api/config/route');
    const res = await GET();
    const body = await res.json();
    expect(body).not.toHaveProperty('NEXT_PUBLIC_TWENTY_URL');
  });

  it('exposes notifuse + site URLs', async () => {
    const { GET } = await import('@/app/api/config/route');
    const res = await GET();
    const body = await res.json();
    expect(body).toHaveProperty('NEXT_PUBLIC_SITE_URL');
    expect(body).toHaveProperty('NEXT_PUBLIC_NOTIFUSE_URL');
    expect(body).toHaveProperty('NEXT_PUBLIC_NOTIFUSE_API_URL');
  });
});

// @vitest-environment node
/** GET /api/mcp/liens-installation : la langue suit ?lang puis Accept-Language (Mail, 27/11) ; le cache distingue les langues. */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: { mcpApp: { findUnique: async () => ({ appKey: 'notifuse', label: 'Mail', enabled: true }) } } }));

import { GET } from '@/app/api/mcp/liens-installation/route';

const lire = async (q: string, h: Record<string, string> = {}) => (await GET(new NextRequest(`https://app.veridian.site/api/mcp/liens-installation${q}`, { headers: h }))).json();

describe('GET /api/mcp/liens-installation', () => {
  it('?lang=en : libellés, étape et phrase en anglais ; Accept-Language anglais sans ?lang : anglais ; sinon français ; Vary posé', async () => {
    const [en, accept, defaut] = await Promise.all([lire('?app=notifuse&lang=en'), lire('?app=notifuse', { 'accept-language': 'en-US,en;q=0.9' }), lire('?app=notifuse')]);
    expect([en.assistants[0].libelle, en.langue, en.app.phrase.startsWith('One Veridian'), accept.langue, defaut.assistants[0].libelle, defaut.langue]).toEqual(['Add to Claude', 'en', true, 'en', 'Ajouter à Claude', 'fr']);
    const r = await GET(new NextRequest('https://app.veridian.site/api/mcp/liens-installation?lang=en'));
    expect(r.headers.get('vary')).toBe('Accept-Language');
  });
});

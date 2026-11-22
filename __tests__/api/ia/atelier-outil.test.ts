/** L'atelier joue un outil : signature, session du tenant, espace imposé (docs/MON-IA.md). */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ signe: vi.fn(), appelant: vi.fn(), traiter: vi.fn() }));
vi.mock('@/lib/ia/atelier', () => ({ vientDeLAtelier: (...a: unknown[]) => m.signe(...a) }));
vi.mock('@/lib/ia/atelier-appel', () => ({ appelantPourAtelier: (...a: unknown[]) => m.appelant(...a) }));
vi.mock('@/lib/mcp/porte', () => ({ traiter: (...a: unknown[]) => m.traiter(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/ia/atelier/outil/route';

const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/ia/atelier/outil', { method: 'POST', body: JSON.stringify(corps) });
const demande = { hubUserId: 'u', tenantId: 't-robert', sessionId: 's1', nom: 'executer_outil', arguments: { nom: 'academy.lister_formations', espace: 't-autre' } };

beforeEach(() => {
  vi.clearAllMocks();
  m.signe.mockReturnValue(true);
  m.appelant.mockResolvedValue({ qui: { hubUserId: 'u' }, t: { hubUserId: 'u', tenantId: 't-robert', sessionId: 's1' } });
  m.traiter.mockResolvedValue({ result: { content: [{ type: 'text', text: 'ok' }] } });
});

describe('POST /api/ia/atelier/outil', () => {
  it('sans signature de l\'atelier : 401, rien joué', async () => {
    m.signe.mockReturnValue(false);
    expect((await POST(req(demande))).status).toBe(401);
    expect(m.traiter).not.toHaveBeenCalled();
  });

  it('session qui n\'est pas celle du client et du tenant : 403, rien joué', async () => {
    m.appelant.mockResolvedValue(null);
    expect((await POST(req(demande))).status).toBe(403);
    expect(m.traiter).not.toHaveBeenCalled();
  });

  it('un outil hors des trois : 400', async () => {
    expect((await POST(req({ ...demande, nom: 'Bash' }))).status).toBe(400);
  });

  it('l\'espace est celui de la conversation, même si le modèle en demande un autre', async () => {
    const r = await POST(req(demande));
    expect(await r.json()).toEqual({ texte: 'ok', erreur: false });
    const params = (m.traiter.mock.calls[0][2] as { params: { arguments: Record<string, unknown> } }).params;
    expect(params.arguments.espace).toBe('t-robert');
  });
});

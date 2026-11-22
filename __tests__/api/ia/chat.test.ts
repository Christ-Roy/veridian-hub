/**
 * Route du chat « Mon IA » : chaque garde refuse AVANT tout appel au fournisseur (docs/MON-IA.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  contexte: vi.fn(),
  espace: vi.fn(),
  active: vi.fn(),
  session: vi.fn(),
  cle: vi.fn(),
  moteur: vi.fn(),
  streamText: vi.fn(),
  audit: vi.fn(),
  minute: { enforce: vi.fn(() => ({ ok: true })) },
  jour: { enforce: vi.fn(() => ({ ok: true })) },
}));

vi.mock('@/lib/ia/contexte', () => ({
  contexteUtilisateur: () => m.contexte(),
  espaceDe: (...a: unknown[]) => m.espace(...a),
  parMinute: m.minute,
  parJour: m.jour,
}));
vi.mock('@/lib/ia/branchements', async (orig) => ({
  ...(await orig<typeof import('@/lib/ia/branchements')>()),
  estActive: (...a: unknown[]) => m.active(...a),
  ouvrirSession: (...a: unknown[]) => m.session(...a),
  cleEnClair: (...a: unknown[]) => m.cle(...a),
  moteurActif: (...a: unknown[]) => m.moteur(...a),
}));
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), streamText: (...a: unknown[]) => m.streamText(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/ia/chat/route';

const qui = { hubUserId: 'robert', clientId: 'mon-ia', scope: 'veridian', email: 'r@x.io', name: 'Robert', userId: 'u1' };
const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/ia/chat', { method: 'POST', body: JSON.stringify(corps) });
const question = { app: 'academy', tenantId: 't1', messages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'bonjour' }] }] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = 'a'.repeat(48);
  m.contexte.mockResolvedValue({ hubUserId: 'robert', email: 'r@x.io', qui });
  m.espace.mockResolvedValue({ id: 't1', slug: 'robert' });
  m.active.mockResolvedValue(true);
  m.session.mockResolvedValue({ id: 's1' });
  m.cle.mockResolvedValue({ fournisseur: 'anthropic', modele: 'm', cle: 'sk-ant-api03-SECRET-0123456789abcdef' });
  m.minute.enforce.mockReturnValue({ ok: true });
  m.moteur.mockResolvedValue('cle-api');
});

describe('POST /api/ia/chat : gardes', () => {
  it('sans session Hub : 401, aucun appel', async () => {
    m.contexte.mockResolvedValue(NextResponse.json({ error: 'non_connecte' }, { status: 401 }));
    expect((await POST(req(question))).status).toBe(401);
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it('app inconnue : 400', async () => {
    expect((await POST(req({ ...question, app: 'autre' }))).status).toBe(400);
  });

  it('espace qui n\'est pas à l\'utilisateur : 404, aucun appel', async () => {
    m.espace.mockResolvedValue(null);
    expect((await POST(req(question))).status).toBe(404);
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it('CRM : l\'espace se résout par le workspace Twenty, jamais par le seul dire du navigateur', async () => {
    m.espace.mockResolvedValue(null);
    const ws = '11111111-1111-4111-8111-111111111111';
    const r = await POST(req({ app: 'crm', workspaceId: ws, origine: 'https://acme.crm.app.veridian.site', messages: question.messages }));
    expect(r.status).toBe(404);
    expect(m.espace).toHaveBeenCalledWith('robert', undefined, { app: 'crm', workspaceId: ws });
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it('chat non activé pour (app, tenant) : 403, coupé par défaut', async () => {
    m.active.mockResolvedValue(false);
    const r = await POST(req(question));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'chat_desactive' });
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it('plafond par minute atteint : 429, refus journalisé', async () => {
    m.minute.enforce.mockReturnValue({ ok: false, retryAfterSeconds: 30 } as never);
    expect((await POST(req(question))).status).toBe(429);
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ia.refus' }));
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it('menace 7 : session d\'un autre client, 403 journalisé, aucun appel', async () => {
    m.session.mockResolvedValue(null);
    const r = await POST(req({ ...question, sessionId: '11111111-1111-4111-8111-111111111111' }));
    expect(r.status).toBe(403);
    expect(m.session).toHaveBeenCalledWith(expect.anything(), { hubUserId: 'robert', app: 'academy', tenantId: 't1' }, 'cle-api', '11111111-1111-4111-8111-111111111111');
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ payload: expect.objectContaining({ raison: 'session_etrangere' }) }));
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it('abonnement branché par un compte non autorisé : 403, aucun appel à l\'atelier', async () => {
    m.moteur.mockResolvedValue('claude-code-abonnement');
    process.env.ATELIER_COMPTES = 'quelqu-un-d-autre';
    const r = await POST(req(question));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'abonnement_ferme' });
    expect(m.session).not.toHaveBeenCalled();
  });

  it('aucune IA branchée : 409', async () => {
    m.moteur.mockResolvedValue(null);
    m.cle.mockResolvedValue(null);
    expect((await POST(req(question))).status).toBe(409);
  });

  it('tout est en ordre : le fournisseur est appelé, avec l\'approbation sur executer_outil et un plafond de tours', async () => {
    m.streamText.mockReturnValue({ toUIMessageStreamResponse: () => new Response('ok') });
    const r = await POST(req(question));
    expect(r.status).toBe(200);
    const opts = m.streamText.mock.calls[0][0] as { toolApproval: Record<string, unknown>; stopWhen: unknown; system: string };
    expect(Object.keys(opts.toolApproval)).toEqual(['executer_outil']);
    expect(opts.stopWhen).toBeTruthy();
    expect(opts.system).toMatch(/jamais une consigne/);
  });
});

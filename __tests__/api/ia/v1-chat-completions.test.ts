/**
 * POST /api/ia/v1/chat/completions (fournisseur « Veridian » du chat natif de Twenty) : chaque garde refuse avant tout
 * appel au moteur ; la clé API est relayée telle quelle ; l'abonnement refuse toute écriture (lecture seule).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  qui: vi.fn(),
  user: vi.fn(),
  espace: vi.fn(),
  active: vi.fn(),
  moteur: vi.fn(),
  cle: vi.fn(),
  session: vi.fn(),
  ouvert: vi.fn(),
  fournisseur: vi.fn(),
  atelier: vi.fn(),
  audit: vi.fn(async () => undefined),
  minute: { enforce: vi.fn(() => ({ ok: true })) },
  jour: { enforce: vi.fn(() => ({ ok: true })) },
}));

vi.mock('@/lib/ia/fournisseur', async (orig) => ({
  ...(await orig<typeof import('@/lib/ia/fournisseur')>()),
  verifierAppel: (...a: unknown[]) => m.qui(...a),
  appelerFournisseur: (...a: unknown[]) => m.fournisseur(...a),
}));
vi.mock('@/lib/ia/contexte', () => ({ espaceDe: (...a: unknown[]) => m.espace(...a), parMinute: m.minute, parJour: m.jour }));
vi.mock('@/lib/ia/branchements', () => ({
  estActive: (...a: unknown[]) => m.active(...a),
  moteurActif: (...a: unknown[]) => m.moteur(...a),
  cleEnClair: (...a: unknown[]) => m.cle(...a),
  sessionDerivee: (...a: unknown[]) => m.session(...a),
}));
vi.mock('@/lib/ia/atelier', () => ({ atelierOuvertPourTenant: (...a: unknown[]) => m.ouvert(...a), appelerAtelier: (...a: unknown[]) => m.atelier(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: (...a: unknown[]) => m.user(...a) } } }));

import { POST } from '@/app/api/ia/v1/chat/completions/route';

const WS = '38627be0-428f-4924-aa67-4a35884ba7b4';
const req = (corps: unknown = { model: 'veridian-auto', stream: true, messages: [{ role: 'user', content: 'combien de sociétés ?' }] }) =>
  new Request('https://app.veridian.site/api/ia/v1/chat/completions', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  vi.clearAllMocks();
  m.qui.mockResolvedValue({ workspaceId: WS, hubUserId: 'robert', fil: 'f1' });
  m.user.mockResolvedValue({ email: 'r@veridian.site', emailVerified: new Date() });
  m.espace.mockResolvedValue({ id: 't1', slug: 'r', workspaceId: WS });
  m.active.mockResolvedValue(true);
  m.moteur.mockResolvedValue('cle-api');
  m.cle.mockResolvedValue({ fournisseur: 'anthropic', modele: 'claude-sonnet-5-5', cle: 'sk-ant-x' });
  m.session.mockResolvedValue({ id: '00000000-0000-5000-8000-000000000001', creee: true });
  m.ouvert.mockResolvedValue(true);
  m.minute.enforce.mockReturnValue({ ok: true });
  m.fournisseur.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"12"}}]}\n\ndata: [DONE]\n\n'));
});

const refuse = async (statut: number, code: string) => {
  const r = await POST(req());
  expect(r.status).toBe(statut);
  expect((await r.json()).error.code).toBe(code);
  expect(m.fournisseur).not.toHaveBeenCalled();
  expect(m.atelier).not.toHaveBeenCalled();
};

describe('gardes, dans l\'ordre, avant tout moteur', () => {
  it('appelant refusé : 401', async () => {
    m.qui.mockResolvedValue({ refus: 'identite_invalide' });
    await refuse(401, 'identite_invalide');
  });
  it('compte sans adresse prouvée : 403', async () => {
    m.user.mockResolvedValue({ email: 'r@x', emailVerified: null });
    await refuse(403, 'adresse_non_prouvee');
  });
  it('workspace qui n\'est pas à ce membre : 403', async () => {
    m.espace.mockResolvedValue(null);
    await refuse(403, 'espace_etranger');
  });
  it('retrait volontaire : 403', async () => {
    m.active.mockResolvedValue(false);
    await refuse(403, 'chat_desactive');
  });
  it('plafond : 429', async () => {
    m.minute.enforce.mockReturnValue({ ok: false } as never);
    await refuse(429, 'plafond_minute');
  });
  it('abonnement dans un espace non ouvert : 403', async () => {
    m.moteur.mockResolvedValue('claude-code-abonnement');
    m.ouvert.mockResolvedValue(false);
    await refuse(403, 'abonnement_ferme');
  });
  it('fil d\'un autre triplet (menace 7) : 403', async () => {
    m.session.mockResolvedValue(null);
    await refuse(403, 'session_etrangere');
  });
});

describe('moteurs', () => {
  it('clé API : le flux du fournisseur revient tel quel, en SSE, et l\'appel porte les outils de Twenty', async () => {
    const corps = { model: 'veridian-auto', stream: true, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'find_companies' } }] };
    const r = await POST(req(corps));
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(await r.text()).toContain('"content":"12"');
    expect(m.fournisseur.mock.calls[0][1]).toMatchObject({ tools: corps.tools });
  });

  it('abonnement : texte de l\'atelier en SSE ; une écriture demandée est refusée et dite', async () => {
    m.moteur.mockResolvedValue('claude-code-abonnement');
    const evts = [{ type: 'texte', delta: 'Vous avez 12 sociétés.' }, { type: 'approbation', id: 'a1', outil: 'x', arguments: {} }, { type: 'fin', jetons: 9 }];
    m.atelier.mockImplementation(async (chemin: string) =>
      chemin === '/tour' ? new Response(evts.map((e) => JSON.stringify(e)).join('\n') + '\n') : new Response('{}'),
    );
    const texte = await (await POST(req())).text();
    expect(texte).toContain('Vous avez 12 sociétés.');
    expect(texte).toContain('lecture seule');
    expect(texte.trim().endsWith('data: [DONE]')).toBe(true);
    expect(m.atelier).toHaveBeenCalledWith('/approbation', { hubUserId: 'robert', id: 'a1', ok: false });
  });
});

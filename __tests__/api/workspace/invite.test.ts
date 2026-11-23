/** Invitation à un espace : un mail de Veridian vers une adresse libre, donc adresse prouvée, bornes, et HTML échappé (23/11). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ prouvee: true, send: vi.fn(), nom: 'Mon espace', id: 'u0' }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: m.id, email: 'proprio@exemple.fr' } }) }));
vi.mock('@/lib/auth/email-proof', () => ({ isEmailProvenForSession: async () => m.prouvee }));
vi.mock('@/lib/email/send', () => ({ sendMail: (...a: unknown[]) => m.send(...a) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    workspaceMember: { findUnique: async () => ({ role: 'OWNER' }) },
    user: { findUnique: async () => null },
    workspace: { findUnique: async () => ({ id: 'w', name: m.nom }) },
    invitation: { create: async () => ({ id: 'i' }) },
  },
}));
import { POST } from '@/app/api/workspace/invite/route';

const inviter = (email: string) => POST(new Request('https://app.veridian.site/api/workspace/invite', { method: 'POST', body: JSON.stringify({ workspaceId: 'w', email, role: 'MEMBER' }) }));
let n = 0;
beforeEach(() => {
  m.send.mockReset().mockResolvedValue(undefined);
  m.prouvee = true;
  m.nom = 'Mon espace';
  m.id = `u${++n}`;
});

describe('POST /api/workspace/invite', () => {
  it('adresse non prouvée : 403, aucun mail', async () => {
    m.prouvee = false;
    expect((await inviter('x@exemple.fr')).status).toBe(403);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('20 invitations par heure et par invitant, puis 429 et plus aucun mail', async () => {
    for (let i = 0; i < 20; i++) expect((await inviter(`p${i}@exemple.fr`)).status).toBe(200);
    expect((await inviter('p21@exemple.fr')).status).toBe(429);
    expect(m.send).toHaveBeenCalledTimes(20);
  });

  it('4 par heure vers une même adresse, quel que soit l\'invitant et l\'écriture', async () => {
    const codes: number[] = [];
    for (const e of ['cible@exemple.fr', 'Cible@exemple.fr', 'CIBLE@exemple.fr', 'cible@EXEMPLE.fr', 'cible@exemple.fr']) {
      m.id = `autre-${codes.length}`;
      codes.push((await inviter(e)).status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });

  it('le nom de l\'espace, choisi par l\'utilisateur, n\'est jamais du HTML dans le mail', async () => {
    m.nom = '<a href="https://evil.example">Votre banque</a>';
    await inviter('html@exemple.fr');
    const html = (m.send.mock.calls[0][0] as { html: string }).html;
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).toContain('&lt;a href=');
  });
});

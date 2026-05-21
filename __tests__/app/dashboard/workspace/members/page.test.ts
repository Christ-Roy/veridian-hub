/**
 * Smoke source pour `/dashboard/workspace/members` post-backfill —
 * vérifie que le placeholder du commit f88b8c0 a bien été remplacé par
 * la vraie page :
 *   - Lookup workspace via members.some
 *   - Self-heal provisionDefaultWorkspace si user orphelin (filet anti-régression)
 *   - Tableau `<MembersTable>` avec liste workspace + rôles
 *   - Modal `<InviteModal>` gated sur canInviteMembers (OWNER/ADMIN)
 *   - Hydratation des emails via User.findMany (jointure manuelle)
 *
 * Le composant interactif est couvert par les tests RTL existants sur
 * MembersTable / InviteModal (à venir), et le rendu visuel sur le spec
 * E2E Playwright `11-ui-invite-flow.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(
  __dirname,
  '../../../../../app/dashboard/workspace/members/page.tsx',
);

describe('/dashboard/workspace/members page source', () => {
  it('le fichier page.tsx existe', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  const src = existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, 'utf-8') : '';

  it("n'a plus de placeholder « Membres à venir » (post-backfill 23/23)", () => {
    // Le placeholder du commit f88b8c0 contenait ces marqueurs.
    expect(src).not.toMatch(/Membres à venir/i);
    expect(src).not.toMatch(/Cette section sera bientôt disponible/i);
  });

  it('importe MembersTable + InviteModal', () => {
    expect(src).toMatch(/MembersTable/);
    expect(src).toMatch(/InviteModal/);
  });

  it('résout le workspace via prisma.workspace.findFirst', () => {
    expect(src).toMatch(/prisma\.workspace\.findFirst/);
  });

  it('hydrate les emails via User.findMany (jointure manuelle)', () => {
    expect(src).toMatch(/prisma\.user\.findMany/);
  });

  it('self-heal via provisionDefaultWorkspace si user orphelin', () => {
    expect(src).toMatch(/provisionDefaultWorkspace/);
  });

  it('gate InviteModal sur canInviteMembers(actorRole)', () => {
    expect(src).toMatch(/canInviteMembers/);
    expect(src).toMatch(/userCanInvite/);
  });

  it('passe les bons props à MembersTable (actorRole + actorUserId)', () => {
    expect(src).toMatch(/actorRole=/);
    expect(src).toMatch(/actorUserId=/);
  });

  it('passe workspaceId à InviteModal', () => {
    expect(src).toMatch(/workspaceId=\{dbWorkspace\.id\}/);
  });

  it('redirect /login si user non auth', () => {
    expect(src).toMatch(/redirect\(['"]\/login['"]\)/);
  });
});

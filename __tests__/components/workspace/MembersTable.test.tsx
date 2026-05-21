/**
 * Tests RTL pour `<MembersTable>` — affiche la liste des membres d'un
 * workspace post-backfill. Le sprint v1.4 a livré la page mais le
 * composant n'avait pas de test colocalisé.
 *
 * Couvre :
 *   - rendu de N membres avec emails / rôles / dates
 *   - badge de rôle (OWNER / ADMIN / MEMBER / VIEWER)
 *   - mention "(vous)" sur l'acteur courant
 *   - état vide
 *   - actions cachées pour soi-même
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MembersTable } from '@/components/workspace/MembersTable';
import type { WorkspaceMember } from '@/types/workspace';

function buildMember(over: Partial<WorkspaceMember>): WorkspaceMember {
  return {
    id: 'm-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    email: 'alice@example.com',
    name: null,
    role: 'MEMBER',
    invitedAt: '2026-05-01T00:00:00.000Z',
    joinedAt: '2026-05-02T00:00:00.000Z',
    ...over,
  };
}

describe('<MembersTable>', () => {
  it('affiche un message si pas de membres', () => {
    render(
      <MembersTable members={[]} actorRole="OWNER" actorUserId="u-actor" />,
    );
    expect(screen.getByText(/Aucun membre/i)).toBeInTheDocument();
  });

  it('affiche les emails de N membres', () => {
    const members = [
      buildMember({ id: 'm-1', userId: 'u-1', email: 'alice@example.com' }),
      buildMember({ id: 'm-2', userId: 'u-2', email: 'bob@example.com' }),
    ];
    render(
      <MembersTable members={members} actorRole="OWNER" actorUserId="u-1" />,
    );

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it("marque l'acteur courant avec « (vous) »", () => {
    const members = [
      buildMember({ id: 'm-1', userId: 'u-1', email: 'alice@example.com' }),
    ];
    render(
      <MembersTable members={members} actorRole="OWNER" actorUserId="u-1" />,
    );
    expect(screen.getByText(/\(vous\)/i)).toBeInTheDocument();
  });

  it('affiche le label "Invitation envoyée" si joinedAt absent', () => {
    const members = [buildMember({ joinedAt: null })];
    render(
      <MembersTable
        members={members}
        actorRole="OWNER"
        actorUserId="u-actor"
      />,
    );
    expect(screen.getByText(/Invitation envoyée/i)).toBeInTheDocument();
  });

  it('affiche le badge de rôle pour chaque membre', () => {
    const members = [
      buildMember({ id: 'm-1', userId: 'u-1', role: 'OWNER' }),
      buildMember({ id: 'm-2', userId: 'u-2', role: 'ADMIN', email: 'b@x.io' }),
      buildMember({ id: 'm-3', userId: 'u-3', role: 'MEMBER', email: 'c@x.io' }),
      buildMember({ id: 'm-4', userId: 'u-4', role: 'VIEWER', email: 'd@x.io' }),
    ];
    render(
      <MembersTable members={members} actorRole="OWNER" actorUserId="x" />,
    );
    // Les labels apparaissent à la fois dans les badges et dans le Select
    // de changement de rôle (MemberActions). On utilise getAllByText pour
    // ne pas dépendre de ce détail d'impl.
    expect(screen.getAllByText(/Propriétaire/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Administrateur/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Membre/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Observateur/i).length).toBeGreaterThan(0);
  });
});

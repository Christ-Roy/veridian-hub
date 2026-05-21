/**
 * Test smoke pour AppSidebar — garantit l'import + export + l'affichage
 * conditionnel du nom de workspace.
 *
 * Régression 2026-05-21 : ajout d'un prop `workspaceName` pour rendre
 * l'objet workspace visible dans le sidebar (sinon les users ne savent
 * pas qu'ils en ont un). Le rendu interactif complet (NavMain, NavUser
 * dropdown) est couvert par E2E Playwright.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock du provider sidebar (requis par les sous-composants client)
vi.mock('@/components/ui/sidebar', async () => {
  const actual = await vi.importActual<any>('@/components/ui/sidebar');
  return {
    ...actual,
    // Force le wrapping minimal sans dépendre du contexte
  };
});

import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider } from '@/components/ui/sidebar';

function renderSidebar(props: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  return render(
    <SidebarProvider>
      <AppSidebar
        user={{ name: 'Alice', email: 'a@x.io', avatar: '/avatars/default.svg' }}
        {...props}
      />
    </SidebarProvider>
  );
}

describe('AppSidebar', () => {
  it('exporte un composant React', () => {
    expect(typeof AppSidebar).toBe('function');
    expect(AppSidebar.name).toBe('AppSidebar');
  });

  it('affiche le workspaceName quand fourni (régression 2026-05-21)', () => {
    renderSidebar({ workspaceName: 'Acme workspace' });
    const wsLabel = screen.getByTestId('sidebar-workspace-name');
    expect(wsLabel.textContent).toBe('Acme workspace');
  });

  it('n\'affiche pas le bloc workspace si workspaceName absent (rétro-compat)', () => {
    renderSidebar({ workspaceName: null });
    expect(screen.queryByTestId('sidebar-workspace-name')).toBeNull();
  });

  it('n\'affiche pas le bloc workspace si workspaceName non passé (rétro-compat)', () => {
    renderSidebar();
    expect(screen.queryByTestId('sidebar-workspace-name')).toBeNull();
  });
});

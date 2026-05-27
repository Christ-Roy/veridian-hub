/**
 * Tests pour components/nav-main.tsx — la liste de navigation principale de
 * la sidebar dashboard.
 *
 * Vérifie la logique de rendu :
 *  - chaque item rend son libellé
 *  - un item actif (url === "/dashboard") porte le style mis en avant
 *    (bg-primary) — le commit i18n a basé le style actif sur l'URL
 *  - un item `disabled` affiche le badge "Bientôt" et n'est PAS un lien
 *    cliquable (pas de <a href>)
 *
 * NavMain consomme le contexte sidebar (SidebarMenuButton) — on l'enveloppe
 * dans SidebarProvider, comme app-sidebar.test.tsx.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutDashboardIcon, ZapIcon, FileIcon, DatabaseIcon } from 'lucide-react';
import { NavMain } from '@/components/nav-main';
import { SidebarProvider } from '@/components/ui/sidebar';

const ITEMS = [
  { title: 'Tableau de bord', url: '/dashboard', icon: LayoutDashboardIcon },
  { title: 'Intégration', url: '/dashboard/integration', icon: ZapIcon, disabled: true },
  { title: 'CRM', url: '/dashboard/crm', icon: DatabaseIcon, badge: 'Nouveau' },
  { title: 'Facturation', url: '/dashboard/billing', icon: FileIcon },
];

function renderNav() {
  return render(
    <SidebarProvider>
      <NavMain items={ITEMS} />
    </SidebarProvider>,
  );
}

describe('NavMain', () => {
  it('rend le libellé de chaque item', () => {
    renderNav();
    expect(screen.getByText('Tableau de bord')).toBeInTheDocument();
    expect(screen.getByText('Intégration')).toBeInTheDocument();
    expect(screen.getByText('Facturation')).toBeInTheDocument();
  });

  it('l\'item actif (url === /dashboard) porte le style mis en avant bg-primary', () => {
    renderNav();
    // SidebarMenuButton est rendu `asChild` → sa className (dont bg-primary
    // pour l'item actif) est fusionnée sur le <a> enfant par Radix Slot.
    const dashboardLink = screen.getByText('Tableau de bord').closest('a');
    expect(dashboardLink).not.toBeNull();
    expect(dashboardLink?.className).toContain('bg-primary');
  });

  it('un item non-actif ne porte PAS le style bg-primary', () => {
    renderNav();
    const billingLink = screen.getByText('Facturation').closest('a');
    expect(billingLink).not.toBeNull();
    expect(billingLink?.className).not.toContain('bg-primary');
  });

  it('un item actif est un lien cliquable vers son url', () => {
    renderNav();
    const link = screen.getByText('Facturation').closest('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/dashboard/billing');
  });

  it('un item disabled affiche le badge "Bientôt" et n\'est PAS un lien', () => {
    renderNav();
    expect(screen.getByText('Bientôt')).toBeInTheDocument();
    // L'item disabled ne doit pas être navigable — pas de <a> autour du libellé.
    const integrationLink = screen.getByText('Intégration').closest('a');
    expect(integrationLink).toBeNull();
  });

  it('un item actif avec badge ("Nouveau") rend le badge à droite + reste cliquable', () => {
    renderNav();
    // L'item CRM porte un badge "Nouveau" — il doit être rendu visuellement,
    // sans casser la navigabilité (régression à surveiller : si on rend le
    // badge comme un sibling du Link au lieu d'un enfant, le href disparaît).
    expect(screen.getByText('Nouveau')).toBeInTheDocument();
    const crmLink = screen.getByText('CRM').closest('a');
    expect(crmLink).not.toBeNull();
    expect(crmLink?.getAttribute('href')).toBe('/dashboard/crm');
  });

  it('un item sans badge ne fait pas apparaître de span "Nouveau" fantôme', () => {
    // Garde-fou : le rendu conditionnel du badge ne doit pas leak.
    render(
      <SidebarProvider>
        <NavMain items={[{ title: 'Solo', url: '/x', icon: FileIcon }]} />
      </SidebarProvider>,
    );
    expect(screen.queryByText('Nouveau')).not.toBeInTheDocument();
  });
});

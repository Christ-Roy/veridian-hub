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
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutDashboardIcon, ZapIcon, FileIcon, SparklesIcon } from 'lucide-react';
import { NavMain } from '@/components/nav-main';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

// Mock déterministe de usePathname → /dashboard. SANS ce mock, le test
// dépend de ce que les autres fichiers laissent dans le mock global
// next/navigation (fuite inter-fichiers → flake : "billing non-actif"
// cassait quand un autre test avait posé pathname=/dashboard/billing).
// On fige le pathname pour que les assertions actif/non-actif soient stables.
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

const ITEMS = [
  { title: 'Tableau de bord', url: '/dashboard', icon: LayoutDashboardIcon },
  { title: 'Intégration', url: '/dashboard/integration', icon: ZapIcon, disabled: true },
  { title: 'Nouveauté', url: '/dashboard/nouveaute', icon: SparklesIcon, badge: 'Nouveau' },
  { title: 'Facturation', url: '/dashboard/billing', icon: FileIcon },
];

function renderNav() {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <NavMain items={ITEMS} />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe('NavMain', () => {
  it('rend le libellé de chaque item', () => {
    renderNav();
    expect(screen.getByText('Tableau de bord')).toBeInTheDocument();
    expect(screen.getByText('Intégration')).toBeInTheDocument();
    expect(screen.getByText('Facturation')).toBeInTheDocument();
  });

  it('l\'item actif (url === /dashboard) est marqué data-active=true', () => {
    renderNav();
    // Depuis la refonte DA, le style actif passe par `data-[active=true]:bg-primary`
    // (classe conditionnelle Tailwind toujours présente dans className). La
    // source de vérité de l'état actif est donc l'attribut `data-active`, pas
    // la présence de la string bg-primary. SidebarMenuButton (asChild) pose
    // data-active sur le <a> enfant via Radix Slot.
    const dashboardLink = screen.getByText('Tableau de bord').closest('a');
    expect(dashboardLink).not.toBeNull();
    expect(dashboardLink?.getAttribute('data-active')).toBe('true');
  });

  it('un item non-actif est marqué data-active=false', () => {
    renderNav();
    const billingLink = screen.getByText('Facturation').closest('a');
    expect(billingLink).not.toBeNull();
    expect(billingLink?.getAttribute('data-active')).toBe('false');
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
    // Régression à surveiller : si on rend le badge comme un sibling du Link
    // au lieu d'un enfant, le href disparaît.
    expect(screen.getByText('Nouveau')).toBeInTheDocument();
    const link = screen.getByText('Nouveauté').closest('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/dashboard/nouveaute');
  });

  it('un item sans badge ne fait pas apparaître de span "Nouveau" fantôme', () => {
    // Garde-fou : le rendu conditionnel du badge ne doit pas leak.
    render(
      <TooltipProvider>
        <SidebarProvider>
          <NavMain items={[{ title: 'Solo', url: '/x', icon: FileIcon }]} />
        </SidebarProvider>
      </TooltipProvider>,
    );
    expect(screen.queryByText('Nouveau')).not.toBeInTheDocument();
  });
});

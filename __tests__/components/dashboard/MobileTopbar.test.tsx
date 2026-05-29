/**
 * Tests pour components/dashboard/MobileTopbar.tsx — barre mobile du dashboard.
 *
 * Comportement vérifié :
 *  - rend le trigger sidebar (hamburger) + le logo Veridian
 *  - le logo pointe vers /dashboard
 *  - le header est masqué en desktop (classe lg:hidden)
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MobileTopbar } from '@/components/dashboard/MobileTopbar';

function renderTopbar() {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <MobileTopbar />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe('MobileTopbar', () => {
  it('rend le logo Veridian pointant vers /dashboard', () => {
    renderTopbar();
    const link = screen.getByText('Veridian').closest('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/dashboard');
  });

  it('rend le bouton trigger de la sidebar (hamburger mobile)', () => {
    renderTopbar();
    // SidebarTrigger rend un <button> (toggle de la sidebar).
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(1);
  });

  it('le header est masqué en desktop (lg:hidden)', () => {
    const { container } = renderTopbar();
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('lg:hidden');
  });
});

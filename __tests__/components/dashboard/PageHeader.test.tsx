/**
 * Tests DashboardPageHeader — en-tête de page standardisé du dashboard.
 * Verrouille le rendu du titre en h1, l'icône optionnelle, la description
 * optionnelle, le slot action et la prop className.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutDashboard } from 'lucide-react';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';

describe('DashboardPageHeader', () => {
  it('rend le titre dans un h1', () => {
    render(<DashboardPageHeader title="Mon titre" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Mon titre');
  });

  it('rend la description quand fournie', () => {
    render(<DashboardPageHeader title="T" description="Ma description" />);
    expect(screen.getByText('Ma description')).toBeTruthy();
  });

  it('ne rend pas de description quand absente', () => {
    const { container } = render(<DashboardPageHeader title="T" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('rend le slot action', () => {
    render(
      <DashboardPageHeader title="T" action={<button type="button">Refresh</button>} />
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('rend une icône SVG quand fournie', () => {
    const { container } = render(
      <DashboardPageHeader title="T" icon={LayoutDashboard} />
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('applique la prop className sur le conteneur racine', () => {
    const { container } = render(
      <DashboardPageHeader title="T" className="mb-8" />
    );
    expect((container.firstChild as HTMLElement).className).toContain('mb-8');
  });

  it('accepte un ReactNode comme description', () => {
    render(
      <DashboardPageHeader
        title="T"
        description={<span data-testid="rich-desc">riche</span>}
      />
    );
    expect(screen.getByTestId('rich-desc')).toBeTruthy();
  });
});

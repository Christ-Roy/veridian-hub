/**
 * Tests AnalyticsTenantPanels — panneaux d'action d'un tenant Analytics
 * (ajout de site, attache GSC). Extraits en client component lors de la
 * migration shadcn de l'admin (ex `<details>` natifs).
 *
 * Vérifie le rendu replié par défaut, le dépliement au clic, et que le
 * `<Select>` GSC ne rend que si le tenant a au moins un site.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AnalyticsTenant } from '@/lib/analytics/client';
import { AnalyticsTenantPanels } from '@/app/dashboard/admin/analytics/AnalyticsTenantPanels';

const noopAction = vi.fn(async () => {});

function makeTenant(overrides: Partial<AnalyticsTenant> = {}): AnalyticsTenant {
  return {
    id: 'tnt_1',
    slug: 'acme',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    sites: [],
    ...overrides,
  };
}

describe('AnalyticsTenantPanels', () => {
  it('rend le bouton "Ajouter un site" replié par défaut', () => {
    render(
      <AnalyticsTenantPanels
        tenant={makeTenant()}
        createSiteAction={noopAction}
        attachGscAction={noopAction}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Ajouter un site/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('déplie le formulaire d\'ajout de site au clic', () => {
    render(
      <AnalyticsTenantPanels
        tenant={makeTenant()}
        createSiteAction={noopAction}
        attachGscAction={noopAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ajouter un site/ }));
    expect(screen.getByPlaceholderText('tramtech.fr')).toBeTruthy();
  });

  it('n\'affiche pas le panneau GSC quand le tenant n\'a aucun site', () => {
    render(
      <AnalyticsTenantPanels
        tenant={makeTenant({ sites: [] })}
        createSiteAction={noopAction}
        attachGscAction={noopAction}
      />,
    );
    expect(screen.queryByText(/Attacher GSC/)).toBeNull();
  });

  it('affiche le panneau GSC quand le tenant a au moins un site', () => {
    render(
      <AnalyticsTenantPanels
        tenant={makeTenant({
          sites: [
            {
              id: 'site_1',
              tenantId: 'tnt_1',
              domain: 'acme.fr',
              name: 'Acme',
              siteKey: 'key_1',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        })}
        createSiteAction={noopAction}
        attachGscAction={noopAction}
      />,
    );
    expect(screen.getByRole('button', { name: /Attacher GSC/ })).toBeTruthy();
  });
});

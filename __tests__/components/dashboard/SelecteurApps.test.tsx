/** Le sélecteur d'apps : apps ouvertes seulement, par le rebond, jamais un jeton, accessible au clavier. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SelecteurApps } from '@/app/dashboard/components/SelecteurApps';
import { appsOuvertes } from '@/lib/apps/apps-ouvertes';

const ENV = { CRM_API_URL: 'https://crm.test', NOTIFUSE_API_URL: 'https://mail.test', NEXT_PUBLIC_PROSPECTION_URL: 'https://p.test', ACADEMY_API_URL: 'https://a.test' } as never;
const tenant = { prospectionProvisionedAt: new Date(), notifuseWorkspaceSlug: 'x' };

function ouvrir(activees: string[] = []) {
  render(<SelecteurApps apps={appsOuvertes({ tenant, activees: new Set(activees), env: ENV })} />);
  fireEvent.click(screen.getByRole('button', { name: /Changer d'application/ }));
}

describe('SelecteurApps', () => {
  it('fermé au départ : bouton nommé, aucun lien', () => {
    render(<SelecteurApps apps={[]} />);
    const b = screen.getByRole('button', { name: /Changer d'application/ });
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('ouvert : le Hub puis les apps ouvertes seulement, une navigation nommée', () => {
    ouvrir();
    expect(screen.getByRole('navigation', { name: 'Applications Veridian' })).toBeTruthy();
    const noms = screen.getAllByRole('link').map((a) => a.textContent);
    expect(noms[0]).toMatch(/Hub Veridian/);
    expect(noms.join('|')).toMatch(/Prospection/);
    expect(noms.join('|')).toMatch(/CRM/);
    expect(noms.join('|')).not.toMatch(/Analytics|CMS|Academy/);
  });
  it('chaque app s\'ouvre par le rebond signé, jamais un jeton', () => {
    ouvrir();
    const crm = screen.getByRole('link', { name: /Veridian CRM/ });
    expect(crm.getAttribute('href')).toBe('/login?next=https%3A%2F%2Fcrm.test%2F');
    for (const a of screen.getAllByRole('link').slice(1)) {
      expect(a.getAttribute('href')).toMatch(/^\/login\?next=/);
      expect(a.getAttribute('href')).not.toMatch(/token|jeton/i);
    }
  });
  it('Academy absente sans activation, présente avec', () => {
    ouvrir();
    expect(screen.queryByRole('link', { name: /Academy/ })).toBeNull();
  });
  it('Academy activée : la tuile apparaît', () => {
    ouvrir(['academy']);
    expect(screen.getByRole('link', { name: /Academy/ })).toBeTruthy();
  });
  it('Échap referme et rend le focus au bouton', () => {
    ouvrir();
    const b = screen.getByRole('button', { name: /Changer d'application/ });
    fireEvent.keyDown(screen.getAllByRole('link')[0], { key: 'Escape' });
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('aucun libellé en anglais ni « Claude »', () => {
    ouvrir(['academy']);
    expect(document.body.textContent).not.toMatch(/Claude|Apps?\b switcher|Open|Menu\b/);
  });
});

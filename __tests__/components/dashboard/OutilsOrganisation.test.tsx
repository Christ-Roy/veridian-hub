/** Un salarié voit les apps de son organisation, par le rebond, et rien à démarrer. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OutilsOrganisation, outilsDe } from '@/app/dashboard/components/OutilsOrganisation';

const ENV = { CRM_API_URL: 'https://crm.test/', NOTIFUSE_API_URL: 'https://mail.test', NEXT_PUBLIC_PROSPECTION_URL: 'https://p.test', ACADEMY_API_URL: 'https://a.test' } as never;
const O = { id: 'A', nom: 'Client', modules: ['crm', 'notifuse', 'academy', 'inconnue'] };

describe('outilsDe', () => {
  it('les apps ouvertes, par le rebond ; Academy seulement activée ; inconnue ou sans adresse : rien', () => {
    expect(outilsDe(O, false, ENV)).toEqual([{ cle: 'crm', url: '/login?next=https%3A%2F%2Fcrm.test%2F' }, { cle: 'notifuse', url: '/login?next=https%3A%2F%2Fmail.test%2Fconsole%2F' }]);
    expect(outilsDe(O, true, ENV).map((x) => x.cle)).toContain('academy');
    expect(outilsDe(O, true, {} as never)).toEqual([]);
  });
});
describe('OutilsOrganisation', () => {
  it('montre l\'organisation et ses apps, aucun essai', () => {
    vi.stubEnv('CRM_API_URL', 'https://crm.test');
    render(<OutilsOrganisation organisations={[{ id: 'A', nom: 'Client', modules: ['crm'] }]} academyActivee={false} />);
    expect(screen.getByRole('heading', { name: 'Client' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ouvrir/ }).getAttribute('href')).toBe('/login?next=https%3A%2F%2Fcrm.test%2F');
    expect(document.body.textContent).not.toMatch(/essai|Commencer/i);
  });
  it('rien d\'ouvert : dit, sans bouton', () => {
    render(<OutilsOrganisation organisations={[{ id: 'A', nom: 'Client', modules: [] }]} academyActivee={false} />);
    expect(screen.getByText(/pas encore ouvert d'application/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

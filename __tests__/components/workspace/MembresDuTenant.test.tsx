import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MembresDuTenant } from '@/components/workspace/MembresDuTenant';

describe('MembresDuTenant', () => {
  it('montre chaque arrivée : qui, par où, depuis quand', () => {
    render(<MembresDuTenant membres={[{ espace: 'Un', email: 'm@x.fr', role: 'member', origine: 'invitation', depuis: new Date('2026-11-24T10:00:00Z') }, { espace: 'Un', email: 'n@x.fr', role: 'member', origine: null, depuis: new Date('2026-11-24T10:00:00Z') }]} />);
    expect(screen.getByText('m@x.fr')).toBeTruthy();
    expect(screen.getByText(/sur invitation, depuis le 24\/11\/2026/)).toBeTruthy();
    expect(screen.getByText(/origine inconnue/)).toBeTruthy();
  });
  it('rien quand personne n\'est entré', () => {
    const { container } = render(<MembresDuTenant membres={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('@/components/emprunt/SortirAvantLaFin', () => ({ SortirAvantLaFin: ({ finMs }: { finMs: number }) => <i data-testid="fin">{finMs}</i> }));
import { BandeauEmprunt } from '@/components/emprunt/BandeauEmprunt';

it('dit chez qui, jusqu\'à quand (heure de Paris), et la sortie est un vrai formulaire', () => {
  const { container } = render(<BandeauEmprunt email="client@c.fr" debutS={Date.UTC(2026, 10, 25, 22, 0) / 1000} />);
  expect(screen.getByRole('status').textContent).toContain('client@c.fr');
  expect(screen.getByRole('status').textContent).toContain('00:00');
  const f = container.querySelector('form')!;
  expect([f.getAttribute('method'), f.getAttribute('action')]).toEqual(['post', '/api/auth/emprunt/sortir']);
  expect(screen.getByRole('button', { name: 'Sortir' })).toBeTruthy();
  expect(screen.getByTestId('fin').textContent).toBe(String(Date.UTC(2026, 10, 25, 23, 0)));
});

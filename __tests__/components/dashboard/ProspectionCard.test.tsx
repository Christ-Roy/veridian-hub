import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@/lib/confetti', () => ({ celebrate: () => {} }));

import { ProspectionCard } from '@/app/dashboard/components/ProspectionCard';

it('ouvre par le rebond, sans jeton ni appel (VER-106)', () => {
  const h = renderToStaticMarkup(<ProspectionCard configured url="/login?next=https%3A%2F%2Fatlas.test%2F" />);
  expect(h).toContain('href="/login?next=https%3A%2F%2Fatlas.test%2F"');
  expect(h).not.toContain('/api/auth/token');
});
it('app non branchée : aucun bouton mort ; pas encore activée : l\'essai', () => {
  expect(renderToStaticMarkup(<ProspectionCard configured url={null} />)).not.toContain('Ouvrir');
  expect(renderToStaticMarkup(<ProspectionCard configured={false} url="/x" />)).toContain('Activer gratuitement');
});

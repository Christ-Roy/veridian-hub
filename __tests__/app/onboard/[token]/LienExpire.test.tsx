import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { LienExpire } from '@/app/onboard/[token]/LienExpire';

const cliquer = async (statut: number, corps: unknown) => {
  const f = vi.fn(async (_url: string) => new Response(JSON.stringify(corps), { status: statut }));
  vi.stubGlobal('fetch', f);
  const vue = render(<LienExpire token="a/b" />);
  expect(vue.container.textContent).not.toContain('@');
  fireEvent.click(screen.getByRole('button', { name: /nouveau lien/ }));
  await waitFor(() => screen.getByRole('status'));
  return { texte: screen.getByRole('status').textContent, bouton: screen.queryByRole('button', { name: /nouveau lien/ }), url: f.mock.calls[0][0] };
};

it('redemande le lien, le dit, et ne propose plus de recliquer', async () => {
  const r = await cliquer(200, { code: 'envoye' });
  expect(r.url).toBe('/api/onboarding/a%2Fb/renouveler');
  expect(r.texte).toContain('envoyé');
  expect(r.bouton).toBeNull();
});
it('une panne se dit, et se retente', async () => {
  const r = await cliquer(500, {});
  expect(r.texte).toContain('échoué');
  expect(r.bouton).not.toBeNull();
});

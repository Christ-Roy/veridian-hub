import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PorteOrganisation } from '@/components/auth/PorteOrganisation';

const aller = vi.fn();
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('location', { ...window.location, assign: aller }); aller.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const rendre = (auto: boolean) => render(<PorteOrganisation porte="asd" organisation="ASD" fournisseur="Infomaniak" auto={auto} />);
const avancer = async (s: number) => { for (let n = 0; n < s; n++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); };

it('part seul après trois secondes, une fois', async () => {
  rendre(true);
  await avancer(6);
  expect(aller.mock.calls).toEqual([['/connexion/asd']]);
});
it('« Me connecter autrement » l\'arrête pour de bon', async () => {
  rendre(true);
  fireEvent.click(screen.getByRole('button', { name: 'Me connecter autrement' }));
  await avancer(10);
  expect(aller).not.toHaveBeenCalled();
});
it('en pause : un bouton, aucun départ', async () => {
  rendre(false);
  await avancer(10);
  expect(aller).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Continuer avec Infomaniak' })).toHaveAttribute('href', '/connexion/asd');
});

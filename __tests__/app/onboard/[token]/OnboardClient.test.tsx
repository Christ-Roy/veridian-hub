import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingInvite } from '@/components/onboarding/types';
import type {
  OnboardingUser,
  UserOnboardingRecord
} from '@/components/onboarding/qualification/types';

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerRefresh = vi.fn();
const signInMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPush,
    replace: routerReplace,
    refresh: routerRefresh
  })
}));

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args)
}));

vi.mock('@/components/onboarding/OnboardingScreen', () => ({
  OnboardingScreen: ({
    state,
    onActiver,
    onDefinirMotDePasse,
    error
  }: {
    state: string;
    onActiver?: () => void;
    onDefinirMotDePasse?: (password: string) => void;
    error?: string | null;
  }) => (
    <div>
      <output data-testid="activation-state">{state}</output>
      {error && <p>{error}</p>}
      {state === 'activation' && <button onClick={onActiver}>Activer</button>}
      {state === 'mot-de-passe' && (
        <button onClick={() => onDefinirMotDePasse?.('Motdepasse10')}>
          Enregistrer le mot de passe
        </button>
      )}
    </div>
  )
}));

vi.mock('@/components/onboarding/qualification/QualificationFlow', () => ({
  QualificationFlow: ({
    user
  }: {
    user: OnboardingUser;
    etat: UserOnboardingRecord;
  }) => <div data-testid="qualification">Bonjour {user.prenom}</div>
}));

import { OnboardClient } from '@/app/onboard/[token]/OnboardClient';

const INVITE: OnboardingInvite = {
  email: 'claire.dubois@exemple-client.fr',
  workspaceName: 'Atelier Dubois',
  invitedBy: 'Robert',
  apps: [],
  expiresAt: '2026-08-31T12:00:00.000Z'
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function commencerActivation() {
  render(<OnboardClient token="token-test" invite={INVITE} />);
  fireEvent.click(screen.getByRole('button', { name: 'Activer' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Enregistrer le mot de passe' })
  );
}

describe('<OnboardClient>', () => {
  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    routerRefresh.mockReset();
    signInMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('active, connecte puis personnalise la qualification avec un prénom lisible', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, user_id: 'user-1', provisioning: [] })
      )
      .mockResolvedValueOnce(jsonResponse({ onboarding: null }));
    signInMock.mockResolvedValue({ error: null });

    commencerActivation();

    expect(await screen.findByTestId('qualification')).toHaveTextContent(
      'Bonjour Claire'
    );
    expect(signInMock).toHaveBeenCalledWith('credentials', {
      email: INVITE.email,
      password: 'Motdepasse10',
      redirect: false
    });
  });

  it('un second onglet qui perd la course atomique revient au login sans boucle', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ ok: false, code: 'activated' }, 400)
    );

    commencerActivation();

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/login'));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(signInMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Enregistrer le mot de passe' })
    ).toBeNull();
  });
});

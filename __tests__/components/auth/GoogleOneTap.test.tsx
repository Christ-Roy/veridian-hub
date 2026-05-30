/**
 * Tests du composant `GoogleOneTap`.
 *
 * Verrouille les garde-fous du ticket :
 *  - N'initialise GSI QUE si user non-loggué (`status: 'unauthenticated'`).
 *  - N'initialise PAS sur les pages MFA (`/auth/mfa`).
 *  - N'initialise PAS sans client_id (cas staging / env vide).
 *  - Au tap, transmet le `credential` au provider `google-one-tap` via
 *    `signIn` avec le `callbackUrl`.
 *
 * `useSession`, `usePathname`, `useEnv` et `signIn` sont mockés. On mocke
 * aussi `window.google.accounts.id` pour observer `initialize`/`prompt`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { GoogleOneTap, isOneTapBlockedPath } from '@/components/auth/GoogleOneTap';

const signInMock = vi.fn();
const useSessionMock = vi.fn();
const usePathnameMock = vi.fn();
const useEnvMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
  useSession: () => useSessionMock(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

vi.mock('@/contexts/EnvContext', () => ({
  useEnv: () => useEnvMock(),
}));

const CLIENT_ID = '123-abc.apps.googleusercontent.com';

/** Installe un faux GSI sur window et renvoie les spies. */
function installFakeGsi() {
  const initialize = vi.fn();
  const prompt = vi.fn();
  const cancel = vi.fn();
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, prompt, cancel, disableAutoSelect: vi.fn() } },
  };
  return { initialize, prompt, cancel };
}

/** `appendChild` natif de `<head>`, capturé avant tout stub. */
const realHeadAppendChild = HTMLHeadElement.prototype.appendChild;

/**
 * Insère un <script id="google-gsi-client"> déjà présent dans le DOM, pour
 * simuler une navigation client interne où GSI est déjà chargé. Utilise
 * l'`appendChild` natif capturé (le bloc de tests stub `appendChild` pour
 * éviter le fetch réseau du script externe) afin que `getElementById` le
 * retrouve réellement. Le script n'a pas de `src` → pas de fetch.
 */
function installExistingGsiScript(): void {
  const script = document.createElement('script');
  script.id = 'google-gsi-client';
  realHeadAppendChild.call(document.head, script);
}

describe('isOneTapBlockedPath', () => {
  it('bloque /auth/mfa et ses sous-chemins', () => {
    expect(isOneTapBlockedPath('/auth/mfa')).toBe(true);
    expect(isOneTapBlockedPath('/auth/mfa?uid=abc')).toBe(true);
  });

  it('autorise les autres chemins', () => {
    expect(isOneTapBlockedPath('/')).toBe(false);
    expect(isOneTapBlockedPath('/login')).toBe(false);
    expect(isOneTapBlockedPath('/signup')).toBe(false);
    expect(isOneTapBlockedPath(null)).toBe(false);
  });
});

describe('GoogleOneTap — render conditionnel', () => {
  /**
   * Scripts injectés par le composant, capturés sans connexion réelle au
   * document. happy-dom refuse le fetch d'un <script> externe (gsi/client)
   * et lèverait une NotSupportedError asynchrone bruyante — on stub donc
   * `document.head.appendChild` pour tous les tests du bloc.
   */
  let appendedScripts: HTMLScriptElement[] = [];
  let appendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    signInMock.mockReset();
    useSessionMock.mockReset();
    usePathnameMock.mockReset();
    useEnvMock.mockReset();
    useEnvMock.mockReturnValue({ NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID });
    usePathnameMock.mockReturnValue('/');
    appendedScripts = [];
    appendSpy = vi
      .spyOn(document.head, 'appendChild')
      .mockImplementation(((node: Node) => {
        if (node instanceof HTMLScriptElement) appendedScripts.push(node);
        return node;
      }) as typeof document.head.appendChild);
    // Nettoie tout script GSI injecté par un test précédent.
    document.getElementById('google-gsi-client')?.remove();
  });

  afterEach(() => {
    appendSpy.mockRestore();
    delete (window as unknown as { google?: unknown }).google;
    document.getElementById('google-gsi-client')?.remove();
  });

  it('user non-loggué + GSI déjà chargé → initialize + prompt appelés', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    // Script GSI déjà présent dans le DOM.
    installExistingGsiScript();

    render(<GoogleOneTap callbackUrl="/dashboard" />);

    expect(gsi.initialize).toHaveBeenCalledTimes(1);
    const cfg = gsi.initialize.mock.calls[0][0];
    expect(cfg.client_id).toBe(CLIENT_ID);
    expect(cfg.auto_select).toBe(true);
    expect(cfg.itp_support).toBe(true);
    // ANTI-RÉGRESSION FedCM (bug prod 2026-05-30) : sans use_fedcm_for_prompt,
    // Chrome ne rend plus le prompt One Tap legacy → la popup ne s'affiche
    // jamais. Ce flag est non-négociable depuis la migration FedCM Google.
    expect(cfg.use_fedcm_for_prompt).toBe(true);
    expect(gsi.prompt).toHaveBeenCalledTimes(1);
  });

  it('user loggué → GSI non initialisé', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'authenticated' });
    installExistingGsiScript();

    render(<GoogleOneTap />);

    expect(gsi.initialize).not.toHaveBeenCalled();
    expect(gsi.prompt).not.toHaveBeenCalled();
  });

  it('session en cours de chargement → GSI non initialisé', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'loading' });
    installExistingGsiScript();

    render(<GoogleOneTap />);

    expect(gsi.initialize).not.toHaveBeenCalled();
  });

  it('page MFA → GSI non initialisé même si non-loggué', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    usePathnameMock.mockReturnValue('/auth/mfa?uid=abc');
    installExistingGsiScript();

    render(<GoogleOneTap />);

    expect(gsi.initialize).not.toHaveBeenCalled();
  });

  it('client_id absent (staging) → GSI non initialisé, script non injecté', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    useEnvMock.mockReturnValue({ NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: '' });

    render(<GoogleOneTap />);

    expect(gsi.initialize).not.toHaveBeenCalled();
    expect(appendedScripts).toHaveLength(0);
  });

  it('user non-loggué sans script GSI → injecte le script gsi/client', () => {
    installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });

    render(<GoogleOneTap />);

    const script = appendedScripts.find((n) => n.id === 'google-gsi-client');
    expect(script).toBeDefined();
    expect(script?.src).toContain('accounts.google.com/gsi/client');
    expect(script?.async).toBe(true);
    expect(script?.defer).toBe(true);
  });

  it('callback GSI → signIn("google-one-tap") avec credential + callbackUrl', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    installExistingGsiScript();

    render(<GoogleOneTap callbackUrl="/dashboard?welcome=1" />);

    // Récupère le callback passé à initialize et simule un tap.
    const cfg = gsi.initialize.mock.calls[0][0];
    cfg.callback({ credential: 'google.id.token' });

    expect(signInMock).toHaveBeenCalledWith('google-one-tap', {
      credential: 'google.id.token',
      callbackUrl: '/dashboard?welcome=1',
    });
  });

  it('callback GSI sans credential → pas de signIn', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    installExistingGsiScript();

    render(<GoogleOneTap />);

    const cfg = gsi.initialize.mock.calls[0][0];
    cfg.callback({ credential: '' });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('context="signup" est transmis à GSI', () => {
    const gsi = installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    installExistingGsiScript();

    render(<GoogleOneTap context="signup" />);

    expect(gsi.initialize.mock.calls[0][0].context).toBe('signup');
  });

  it('ne rend aucun markup visible', () => {
    installFakeGsi();
    useSessionMock.mockReturnValue({ status: 'unauthenticated' });
    const { container } = render(<GoogleOneTap />);
    expect(container.innerHTML).toBe('');
  });
});

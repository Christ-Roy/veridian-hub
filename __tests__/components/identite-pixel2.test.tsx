/** Reprise d'audit visuel (pixel2) : ce que la prod laissait ouvert. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), dismiss: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn(), signIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import ConnectedProvidersList from '@/components/account/ConnectedProvidersList';
import EmailForm from '@/components/ui/AccountForms/EmailForm';
import NameForm from '@/components/ui/AccountForms/NameForm';
import { SecurityMfaToggle } from '@/app/dashboard/settings/security/SecurityMfaToggle';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

const src = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8');
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  Object.values(toastMock).forEach((m) => m.mockClear());
  vi.stubGlobal('fetch', fetchMock);
});

describe('Méthodes de connexion : de vraies icônes, pas des emojis', () => {
  it('Google, Microsoft et mot de passe rendent des SVG', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        providers: [
          { id: '1', provider: 'google', providerAccountId: 'a@x.fr', type: 'oauth' },
          { id: '2', provider: 'microsoft-entra-id', providerAccountId: 'a@x.fr', type: 'oauth' },
          { id: '3', provider: 'credentials', providerAccountId: 'a@x.fr', type: 'credentials' },
        ],
      }),
    });
    const { container } = render(<ConnectedProvidersList />);
    await waitFor(() => expect(container.querySelectorAll('li[data-provider]').length).toBe(3));
    container.querySelectorAll('li[data-provider]').forEach((li) => {
      expect(li.querySelector('svg')).not.toBeNull();
    });
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('Nom et email', () => {
  it('champs pleine largeur (borne max), pas la moitié', () => {
    render(<NameForm userName="Alice" />);
    const champ = screen.getByPlaceholderText('Votre nom');
    expect(champ.className).toContain('w-full');
    expect(champ.className).not.toContain('w-1/2');
    expect(champ.className).toContain('border-muted-foreground');
  });

  it('un nouvel envoi efface le message précédent', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<EmailForm userEmail="a@x.fr" />);
    fireEvent.change(screen.getByPlaceholderText('Votre email'), { target: { value: 'b@x.fr' } });
    fireEvent.submit(document.getElementById('emailForm')!);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.dismiss).toHaveBeenCalled();
  });

  it('un seul toast visible à la fois', () => {
    expect(src('components/ui/sonner.tsx')).toMatch(/visibleToasts=\{1\}/);
  });
});

describe('Sécurité', () => {
  it('l’email se coupe après @ ou . et jamais au milieu d’un mot', () => {
    const { container } = render(<SecurityMfaToggle initialEnabled={false} email="e2e-sso@x.veridian.site" hasPassword />);
    expect(container.querySelectorAll('wbr').length).toBeGreaterThanOrEqual(2);
    expect(container.innerHTML).not.toContain('break-all');
    expect(container.textContent).toContain('e2e-sso@x.veridian.site');
  });
});

describe('Cibles tactiles', () => {
  it('le bouton de sidebar fait 44 px au téléphone', () => {
    render(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );
    const bouton = document.querySelector('[data-sidebar="trigger"]') as HTMLElement;
    expect(bouton.className).toContain('h-11');
    expect(bouton.className).toContain('w-11');
  });
});

describe('Fond des pages d’authentification', () => {
  it('le fond couvre tout le contenu (absolute), pas seulement la fenêtre (fixed)', () => {
    const css = src('styles/main.css');
    const bloc = css.slice(css.indexOf('.auth-screen::before {'), css.indexOf('}', css.indexOf('.auth-screen::before {')));
    expect(bloc).toMatch(/position:\s*absolute/);
    expect(bloc).not.toMatch(/position:\s*fixed/);
  });
});

describe('Vouvoiement sur les écrans d’identité', () => {
  const FICHIERS = [
    'app/auth/mfa/page.tsx',
    'app/dashboard/settings/security/page.tsx',
    'app/dashboard/settings/security/SecurityMfaToggle.tsx',
    'app/dashboard/settings/security/SignOutEverywhere.tsx',
    'lib/mfa/index.ts',
    'app/dashboard/components/CrmCard.tsx',
    'app/dashboard/components/ProspectionCard.tsx',
    'components/auth/LoginForm.tsx',
    'components/auth/SignupForm.tsx',
    'components/auth/LoginErrorBanner.tsx',
    'components/ui/AccountForms/PasswordForm.tsx',
  ];
  const TUTOIEMENT = /(Réessaye|Reconnecte|Coupe|Clique|Vérifie|Saisis|Choisis)\b(?!z)|\b(ton|ta|tes) [a-zéèà]|\bt&apos;|\bt'(es|a|en)\b|\bTu\b|\btu (peux|as|dois)\b/;
  it.each(FICHIERS)('%s ne tutoie pas', (f) => {
    // Hors commentaires.
    const texte = src(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(texte.match(TUTOIEMENT)?.[0] ?? null).toBeNull();
  });
});

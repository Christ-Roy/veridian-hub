/**
 * Tests LoginErrorBanner — vérifie le mapping codes Auth.js → messages FR.
 *
 * Stratégie : on stub useSearchParams pour piloter `?error=<code>` et on
 * vérifie que le composant render le bon titre + message + variant.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoginErrorBanner, resolveError } from '@/components/auth/LoginErrorBanner';

const mockSearchParams = (code: string | null) => {
  vi.doMock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(code ? `error=${code}` : ''),
  }));
};

describe('resolveError (logique pure)', () => {
  it('renvoie null si pas de code', () => {
    expect(resolveError(null)).toBeNull();
    expect(resolveError(undefined)).toBeNull();
    expect(resolveError('')).toBeNull();
  });

  it('renvoie un message dédié pour OAuthAccountNotLinked', () => {
    const entry = resolveError('OAuthAccountNotLinked');
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/déjà lié/i);
    expect(entry!.variant).toBe('destructive');
  });

  it('renvoie un message dédié pour AccessDenied (non destructif)', () => {
    const entry = resolveError('AccessDenied');
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/annulée/i);
    expect(entry!.variant).toBe('default');
  });

  it('renvoie un message dédié pour Configuration', () => {
    const entry = resolveError('Configuration');
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/configuration/i);
  });

  it('renvoie un message dédié pour Verification (lien magic expiré)', () => {
    const entry = resolveError('Verification');
    expect(entry!.title).toMatch(/expir/i);
  });

  it('renvoie un message dédié pour OAuthCallbackError', () => {
    const entry = resolveError('OAuthCallbackError');
    expect(entry!.title).toMatch(/OAuth/i);
  });

  it('renvoie un message dédié pour OAuthSigninError', () => {
    const entry = resolveError('OAuthSigninError');
    expect(entry).not.toBeNull();
  });

  it('renvoie un message dédié pour CredentialsSignin', () => {
    const entry = resolveError('CredentialsSignin');
    expect(entry!.title).toMatch(/invalides/i);
  });

  it('renvoie le message Default pour un code inconnu', () => {
    const entry = resolveError('SomeUnknownCode');
    expect(entry).not.toBeNull();
    expect(entry!.title).toMatch(/erreur/i);
  });
});

describe('LoginErrorBanner (rendu)', () => {
  it("ne render rien quand il n'y a pas de ?error=", () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useSearchParams: () => new URLSearchParams(''),
    }));
    // Re-require le composant pour qu'il pick up le mock courant
    return import('@/components/auth/LoginErrorBanner').then(({ LoginErrorBanner: Banner }) => {
      const { container } = render(<Banner />);
      expect(container.firstChild).toBeNull();
    });
  });

  it('render le message AccessDenied avec data-error-code', () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useSearchParams: () => new URLSearchParams('error=AccessDenied'),
    }));
    return import('@/components/auth/LoginErrorBanner').then(({ LoginErrorBanner: Banner }) => {
      render(<Banner />);
      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.getAttribute('data-error-code')).toBe('AccessDenied');
      expect(alert.textContent).toMatch(/annulée/i);
    });
  });

  it('render le message OAuthAccountNotLinked', () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useSearchParams: () => new URLSearchParams('error=OAuthAccountNotLinked'),
    }));
    return import('@/components/auth/LoginErrorBanner').then(({ LoginErrorBanner: Banner }) => {
      render(<Banner />);
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(/déjà lié/i);
    });
  });

  it('render le message Default pour un code inconnu', () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useSearchParams: () => new URLSearchParams('error=XYZ'),
    }));
    return import('@/components/auth/LoginErrorBanner').then(({ LoginErrorBanner: Banner }) => {
      render(<Banner />);
      const alert = screen.getByRole('alert');
      expect(alert.getAttribute('data-error-code')).toBe('XYZ');
    });
  });
});

// Ignore l'avertissement de mock — c'est volontaire pour piloter les params.
// La structure import-dynamique + vi.doMock + resetModules est nécessaire car
// useSearchParams est un hook qu'on ne peut pas paramétrer après le 1er render.
mockSearchParams;

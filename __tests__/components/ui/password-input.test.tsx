/**
 * Tests pour components/ui/password-input.tsx — input mot de passe avec
 * bouton œil afficher/masquer.
 *
 * Comportement vérifié (pas du smoke) :
 *  - rend un <input type="password"> par défaut (valeur masquée)
 *  - le clic sur le bouton bascule type password ↔ text + aria-label/pressed
 *  - les props natives (name, placeholder, value…) sont forwardées à l'input
 *  - le bouton est tabIndex=-1 (pas dans l'ordre de tab, UX clavier)
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PasswordInput } from '@/components/ui/password-input';

describe('PasswordInput', () => {
  it('rend un input type="password" par défaut (valeur masquée)', () => {
    render(<PasswordInput name="password" placeholder="••••" />);
    const input = document.querySelector('input[name="password"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('type')).toBe('password');
  });

  it('le bouton bascule la visibilité password ↔ text', () => {
    render(<PasswordInput name="password" />);
    const input = document.querySelector('input[name="password"]') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: /Afficher le mot de passe/i });

    expect(input.getAttribute('type')).toBe('password');

    fireEvent.click(toggle);
    expect(input.getAttribute('type')).toBe('text');
    // Le label bascule en miroir
    expect(
      screen.getByRole('button', { name: /Masquer le mot de passe/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Masquer le mot de passe/i }));
    expect(input.getAttribute('type')).toBe('password');
  });

  it('reflète l\'état via aria-pressed', () => {
    render(<PasswordInput name="password" />);
    const toggle = screen.getByRole('button', { name: /Afficher le mot de passe/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: /Masquer/i }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('forwarde les props natives à l\'input (name, placeholder, autoComplete)', () => {
    render(
      <PasswordInput
        name="password"
        placeholder="Votre mot de passe"
        autoComplete="current-password"
      />,
    );
    const input = document.querySelector('input[name="password"]') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe('Votre mot de passe');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
  });

  it('le bouton toggle est hors ordre de tabulation (tabIndex=-1)', () => {
    render(<PasswordInput name="password" />);
    const toggle = screen.getByRole('button', { name: /Afficher/i });
    expect(toggle.getAttribute('tabindex')).toBe('-1');
    // type=button : ne soumet jamais le formulaire parent
    expect(toggle.getAttribute('type')).toBe('button');
  });
});

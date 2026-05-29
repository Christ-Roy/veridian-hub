/**
 * Tests pour components/icons/VeridianHubLogo.tsx (VeridianWordmark).
 *
 * Comportement vérifié :
 *  - rend toujours le badge "Veridian" + le suffixe (défaut ".hub")
 *  - le suffixe est personnalisable (".mail", ".analytics"…)
 *  - sans href : rend un <span> (pas de lien)
 *  - avec href : rend un <a> pointant dessus
 *  - muted ajoute le style grisé (app "Bientôt")
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VeridianWordmark } from '@/components/icons/VeridianHubLogo';

describe('VeridianWordmark', () => {
  it('rend le badge "Veridian" + suffixe par défaut ".hub"', () => {
    render(<VeridianWordmark />);
    expect(screen.getByText('Veridian')).toBeInTheDocument();
    expect(screen.getByText('.hub')).toBeInTheDocument();
  });

  it('personnalise le suffixe (ex. .mail)', () => {
    render(<VeridianWordmark suffix=".mail" />);
    expect(screen.getByText('.mail')).toBeInTheDocument();
    expect(screen.queryByText('.hub')).not.toBeInTheDocument();
  });

  it('sans href : aucun lien rendu', () => {
    const { container } = render(<VeridianWordmark suffix=".hub" />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('avec href : rend un <a> vers la cible', () => {
    render(<VeridianWordmark suffix=".hub" href="/dashboard" />);
    const link = screen.getByText('Veridian').closest('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/dashboard');
  });

  it('muted applique le style grisé (app prochainement)', () => {
    render(<VeridianWordmark suffix=".crm" muted />);
    // le wrapper interne porte opacity/grayscale
    const grayed = document.querySelector('.grayscale');
    expect(grayed).not.toBeNull();
  });
});

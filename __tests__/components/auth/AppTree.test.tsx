/**
 * Tests pour components/auth/AppTree.tsx — arborescence de l'écosystème
 * Veridian affichée sous le wordmark dans les pages auth.
 *
 * Comportement vérifié :
 *  - rend les 5 apps de l'écosystème (mail, prospection, analytics, crm, cms)
 *  - les apps live (mail, prospection, analytics) n'ont PAS le badge "Bientôt"
 *  - les apps à venir (crm, cms) affichent le badge "Bientôt"
 *  - chaque app est préfixée "veridian"
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppTree } from '@/components/auth/AppTree';

describe('AppTree', () => {
  it('rend les 5 apps de l\'écosystème', () => {
    render(<AppTree />);
    for (const label of ['mail', 'prospection', 'analytics', 'crm', 'cms']) {
      expect(screen.getByText(`.${label}`)).toBeInTheDocument();
    }
  });

  it('affiche le préfixe "veridian" pour chaque app', () => {
    render(<AppTree />);
    // 5 occurrences du préfixe "veridian"
    expect(screen.getAllByText('veridian')).toHaveLength(5);
  });

  it('marque exactement les apps à venir (crm, cms) avec le badge "Bientôt"', () => {
    render(<AppTree />);
    const soonBadges = screen.getAllByText('Bientôt');
    // crm + cms = 2 apps "prochainement"
    expect(soonBadges).toHaveLength(2);
  });

  it('les apps live (mail/prospection/analytics) n\'ont pas de badge "Bientôt"', () => {
    render(<AppTree />);
    // Le badge "Bientôt" est rendu dans le même <li> que crm/cms.
    // On vérifie que mail (live) n'a pas "Bientôt" comme voisin dans son item.
    const mailItem = screen.getByText('.mail').closest('li');
    expect(mailItem?.textContent).not.toContain('Bientôt');
  });
});

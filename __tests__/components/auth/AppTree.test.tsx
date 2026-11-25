/**
 * Tests pour components/auth/AppTree.tsx — arborescence de l'écosystème
 * Veridian affichée sous le wordmark dans les pages auth.
 *
 * Comportement vérifié :
 *  - rend les 5 apps de l'écosystème (mail, prospection, analytics, crm, cms)
 *  - les apps live (mail, prospection, analytics, crm) n'ont PAS le badge "Bientôt"
 *  - l'app à venir (cms) affiche le badge "Bientôt"
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

  it('marque exactement les apps à venir (cms) avec le badge "Bientôt"', () => {
    render(<AppTree />);
    const soonBadges = screen.getAllByText('Bientôt');
    // Le CRM est ouvert à tout compte (25/11 : l'écran d'accueil le disait encore « bientôt »).
    expect(soonBadges).toHaveLength(1);
    expect(screen.getByText('.crm').closest('li')?.textContent).not.toContain('Bientôt');
  });

  it('les apps live (mail/prospection/analytics) n\'ont pas de badge "Bientôt"', () => {
    render(<AppTree />);
    // Le badge "Bientôt" est rendu dans le même <li> que crm/cms.
    // On vérifie que mail (live) n'a pas "Bientôt" comme voisin dans son item.
    const mailItem = screen.getByText('.mail').closest('li');
    expect(mailItem?.textContent).not.toContain('Bientôt');
  });
});

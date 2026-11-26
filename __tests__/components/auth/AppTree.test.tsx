/**
 * Tests pour components/auth/AppTree.tsx — arborescence de l'écosystème
 * Veridian affichée sous le wordmark dans les pages auth.
 *
 * Comportement vérifié :
 *  - rend les 4 apps proposées (mail, prospection, analytics, crm) ; le CMS s'éteint, il n'est plus proposé (26/11)
 *  - aucune n'a le badge "Bientôt"
 *  - chaque app est préfixée "veridian"
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppTree } from '@/components/auth/AppTree';

describe('AppTree', () => {
  it('rend les 4 apps proposées, et plus le CMS (il s\'éteint, 26/11)', () => {
    render(<AppTree />);
    for (const label of ['mail', 'prospection', 'analytics', 'crm']) {
      expect(screen.getByText(`.${label}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('.cms')).toBeNull();
  });

  it('affiche le préfixe "veridian" pour chaque app', () => {
    render(<AppTree />);
    expect(screen.getAllByText('veridian')).toHaveLength(4);
  });

  it('aucune app annoncée « Bientôt » (le CRM est ouvert, le CMS n\'est plus proposé)', () => {
    render(<AppTree />);
    expect(screen.queryAllByText('Bientôt')).toHaveLength(0);
  });

  it('les apps live (mail/prospection/analytics) n\'ont pas de badge "Bientôt"', () => {
    render(<AppTree />);
    // Le badge "Bientôt" est rendu dans le même <li> que crm/cms.
    // On vérifie que mail (live) n'a pas "Bientôt" comme voisin dans son item.
    const mailItem = screen.getByText('.mail').closest('li');
    expect(mailItem?.textContent).not.toContain('Bientôt');
  });
});

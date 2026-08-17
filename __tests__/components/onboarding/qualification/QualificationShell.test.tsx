/**
 * Tests de `QualificationShell` — l'habillage plein écran du parcours.
 *
 * Il porte trois garde-fous mobiles (dvh, scroll interne, safe-area) et,
 * depuis la revue, l'indice de défilement : sans lui, quand une question
 * dépasse malgré tout, le client croit que la question n'a que les réponses
 * qu'il voit.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { QualificationShell } from '@/components/onboarding/qualification/QualificationShell';

describe('QualificationShell — les pièges du plein écran mobile', () => {
  it('dimensionne en dvh avec repli vh, jamais en min-h-screen', () => {
    // `100vh` compte la barre d'adresse rétractée : l'écran déborde et la
    // page devient scrollable « sur du vide ».
    const { container } = render(
      <QualificationShell>
        <p>x</p>
      </QualificationShell>,
    );
    const racine = container.firstElementChild as HTMLElement;
    expect(racine).toHaveClass('h-screen');
    expect(racine.className).toContain('100dvh');
    expect(racine.className).not.toContain('min-h-screen');
  });

  it('confine le défilement à la zone centrale', () => {
    // Si le scroll vivait sur la page, l'en-tête et le pied disparaîtraient
    // au défilement et le bouton d'action deviendrait inatteignable.
    const { container } = render(
      <QualificationShell pied={<span>pied</span>}>
        <p>x</p>
      </QualificationShell>,
    );
    const racine = container.firstElementChild as HTMLElement;
    expect(racine).toHaveClass('overflow-hidden');

    const zone = racine.querySelector('.overflow-y-auto');
    expect(zone).not.toBeNull();
    // `min-h-0` : sans lui, un enfant flex refuse de rétrécir et déborde.
    expect(zone).toHaveClass('min-h-0');
  });

  it('réserve les encoches et la barre gestuelle', () => {
    const { container } = render(
      <QualificationShell>
        <p>x</p>
      </QualificationShell>,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain(
      'safe-area-inset',
    );
  });

  it('verrouille le défilement quand on le lui demande', () => {
    const { container } = render(
      <QualificationShell verrouillerScroll>
        <p>x</p>
      </QualificationShell>,
    );
    expect(container.querySelector('.overflow-y-auto')).toBeNull();
  });
});

describe('QualificationShell — en-tête, pied et progression', () => {
  it('parle humain plutôt que panneau de réglages', () => {
    // « Configuration de votre espace » était du vocabulaire de logiciel.
    render(
      <QualificationShell>
        <p>x</p>
      </QualificationShell>,
    );
    expect(screen.getByText('On prépare votre espace')).toBeInTheDocument();
    expect(screen.queryByText('Configuration de votre espace')).toBeNull();
  });

  it('affiche la progression en barre, sans compteur chiffré', () => {
    render(
      <QualificationShell progression={0.5}>
        <p>x</p>
      </QualificationShell>,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('borne la progression entre 0 et 100', () => {
    const { rerender } = render(
      <QualificationShell progression={1.4}>
        <p>x</p>
      </QualificationShell>,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    const barre = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(barre.style.width).toBe('100%');

    rerender(
      <QualificationShell progression={-0.5}>
        <p>x</p>
      </QualificationShell>,
    );
    expect(
      (screen.getByRole('progressbar').firstElementChild as HTMLElement).style.width,
    ).toBe('0%');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('n’affiche le pied que lorsqu’il a quelque chose à porter', () => {
    const { rerender } = render(
      <QualificationShell>
        <p>x</p>
      </QualificationShell>,
    );
    expect(screen.queryByText('Retour')).toBeNull();

    rerender(
      <QualificationShell pied={<span>Retour</span>}>
        <p>x</p>
      </QualificationShell>,
    );
    expect(screen.getByText('Retour')).toBeInTheDocument();
  });

  it('n’applique PAS le masque de défilement quand rien ne dépasse', () => {
    // Le masque doit signaler une suite, pas manger le bas d'un contenu qui
    // tient déjà. En JSDOM, scrollHeight === clientHeight === 0 : rien ne
    // dépasse, donc pas de masque.
    const { container } = render(
      <QualificationShell>
        <p>x</p>
      </QualificationShell>,
    );
    const zone = container.querySelector('.overflow-y-auto') as HTMLElement;
    expect(zone.className).not.toContain('mask-image');
  });
});

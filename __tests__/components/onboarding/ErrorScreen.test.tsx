/**
 * Tests de `components/onboarding/ErrorScreen.tsx` — écrans 5 et 6, les
 * sorties de route.
 *
 * Un seul composant sert deux situations très différentes, pilotées par la
 * prop `variant`. L'enjeu est qu'elles ne se mélangent jamais :
 *
 *  - `expire` : le lien est périmé, rien n'est cassé. Le client doit pouvoir
 *    s'en renvoyer un tout seul — c'est ce qui évite un email à Robert.
 *  - `technique` : le provisioning a échoué. On ne montre aucune trace
 *    technique, on propose de réessayer.
 *
 * Un branchement inversé enverrait un client bloqué relancer un provisioning
 * mort, ou ferait croire à une panne alors que le lien avait juste expiré.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ErrorScreen } from '@/components/onboarding/ErrorScreen';

describe('ErrorScreen — variante « expire »', () => {
  it('annonce l’expiration et propose un nouveau lien', () => {
    render(<ErrorScreen variant="expire" />);

    expect(screen.getByText('Ce lien a expiré')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Recevoir un nouveau lien/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Une erreur est survenue')).toBeNull();
  });

  it('affiche l’adresse de destination quand l’email est connu', () => {
    render(<ErrorScreen variant="expire" email="claire.dubois@exemple-client.fr" />);

    expect(screen.getByText(/Le nouveau lien sera envoyé à/)).toBeInTheDocument();
    expect(
      screen.getByText('claire.dubois@exemple-client.fr'),
    ).toBeInTheDocument();
  });

  it('masque le bloc destinataire quand l’email est inconnu', () => {
    // Cas réel : token illisible, on ne sait pas à qui renvoyer. Promettre un
    // envoi sans savoir où serait un mensonge à l'écran.
    render(<ErrorScreen variant="expire" />);
    expect(screen.queryByText(/Le nouveau lien sera envoyé à/)).toBeNull();
  });
});

describe('ErrorScreen — variante « technique »', () => {
  it('annonce la panne et propose de réessayer', () => {
    render(<ErrorScreen variant="technique" />);

    expect(screen.getByText('Une erreur est survenue')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Réessayer/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ce lien a expiré')).toBeNull();
  });

  it('n’affiche jamais le bloc destinataire, même si un email est passé', () => {
    // Le renvoi de lien n'a aucun sens sur une panne de provisioning : le
    // bloc est conditionné à la variante, pas seulement à la présence d'email.
    render(
      <ErrorScreen variant="technique" email="claire.dubois@exemple-client.fr" />,
    );

    expect(screen.queryByText(/Le nouveau lien sera envoyé à/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Recevoir un nouveau lien/i }),
    ).toBeNull();
  });
});

describe('ErrorScreen — recours du client', () => {
  it('appelle onRetry au clic, quelle que soit la variante', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ErrorScreen variant="expire" onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Recevoir un nouveau lien/i }));

    rerender(<ErrorScreen variant="technique" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Réessayer/i }));

    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('propose toujours le support, avec un mailto Veridian par défaut', () => {
    render(<ErrorScreen variant="technique" />);

    const lien = screen.getByRole('link', { name: /Contacter le support/i });
    expect(lien).toHaveAttribute('href', 'mailto:contact@veridian.site');
  });

  it('laisse la page réelle surcharger le lien de support', () => {
    render(<ErrorScreen variant="expire" supportHref="/aide" />);
    expect(
      screen.getByRole('link', { name: /Contacter le support/i }),
    ).toHaveAttribute('href', '/aide');
  });

  it('ne jette pas quand onRetry n’est pas fourni', () => {
    render(<ErrorScreen variant="technique" />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /Réessayer/i })),
    ).not.toThrow();
  });
});

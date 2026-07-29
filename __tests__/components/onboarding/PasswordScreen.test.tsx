/**
 * Tests de `components/onboarding/PasswordScreen.tsx` — écran 2, le choix du
 * mot de passe.
 *
 * C'est l'écran le plus chargé en logique du flow, et celui qui remplace le
 * contournement actuel (mot de passe provisoire envoyé en clair par email).
 * Deux choses doivent être verrouillées :
 *
 *  1. La soumission n'aboutit QUE si les règles de robustesse passent ET que
 *     la confirmation correspond. Un bouton qui laisse filer un mot de passe
 *     faible ou une confirmation divergente crée un compte que le client ne
 *     saura pas rouvrir.
 *  2. Le retour visuel est vivant : les règles se valident au fil de la
 *     frappe, l'erreur de confirmation n'apparaît qu'après interaction.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PasswordScreen } from '@/components/onboarding/PasswordScreen';
import type { OnboardingInvite } from '@/components/onboarding/types';

const INVITE: OnboardingInvite = {
  email: 'claire.dubois@exemple-client.fr',
  workspaceName: 'Atelier Dubois',
  invitedBy: 'Robert Brunon',
  apps: [],
  expiresAt: '2026-08-15T18:00:00.000Z',
};

/** Mot de passe qui satisfait les trois règles (10+, majuscule, chiffre). */
const VALIDE = 'Motdepasse1';

function setup(props: Partial<React.ComponentProps<typeof PasswordScreen>> = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <PasswordScreen invite={INVITE} onSubmit={onSubmit} {...props} />,
  );
  const motDePasse = screen.getByLabelText('Mot de passe') as HTMLInputElement;
  const confirmation = screen.getByLabelText('Confirmation') as HTMLInputElement;
  const bouton = screen.getByRole('button', { name: /Créer mon accès/i });
  return { ...utils, onSubmit, motDePasse, confirmation, bouton };
}

describe('PasswordScreen — règles de robustesse', () => {
  it('démarre avec les trois règles non satisfaites et le bouton bloqué', () => {
    const { bouton } = setup();

    expect(screen.getByText('Au moins 10 caractères')).toBeInTheDocument();
    expect(screen.getByText('Une majuscule')).toBeInTheDocument();
    expect(screen.getByText('Un chiffre')).toBeInTheDocument();
    expect(bouton).toBeDisabled();
  });

  it('laisse le bouton bloqué tant qu’une seule règle manque', () => {
    const { motDePasse, confirmation, bouton } = setup();

    // 10+ caractères et une majuscule, mais aucun chiffre.
    fireEvent.change(motDePasse, { target: { value: 'Motdepassesansnombre' } });
    fireEvent.change(confirmation, {
      target: { value: 'Motdepassesansnombre' },
    });
    expect(bouton).toBeDisabled();
  });

  it('refuse un mot de passe trop court même bien composé', () => {
    const { motDePasse, confirmation, bouton } = setup();

    fireEvent.change(motDePasse, { target: { value: 'Abc12345' } }); // 8 signes
    fireEvent.change(confirmation, { target: { value: 'Abc12345' } });
    expect(bouton).toBeDisabled();
  });

  it('accepte une majuscule accentuée comme majuscule', () => {
    // La regex couvre l'intervalle latin étendu : un client francophone qui
    // commence par « Étoile » ne doit pas être bloqué sur une règle qu'il voit
    // pourtant satisfaite.
    const { motDePasse, confirmation, bouton } = setup();

    fireEvent.change(motDePasse, { target: { value: 'Étoile1234' } });
    fireEvent.change(confirmation, { target: { value: 'Étoile1234' } });
    expect(bouton).not.toBeDisabled();
  });

  it('débloque le bouton dès que les trois règles et la confirmation passent', () => {
    const { motDePasse, confirmation, bouton } = setup();

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    expect(bouton).toBeDisabled(); // confirmation encore vide
    fireEvent.change(confirmation, { target: { value: VALIDE } });
    expect(bouton).not.toBeDisabled();
  });
});

describe('PasswordScreen — confirmation', () => {
  it('n’affiche pas d’erreur de divergence avant interaction', () => {
    const { motDePasse, confirmation } = setup();

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    fireEvent.change(confirmation, { target: { value: 'autre-chose' } });
    // Pas encore de blur ni de tentative d'envoi : on ne réprimande pas un
    // client en train de taper.
    expect(
      screen.queryByText(/ne sont pas identiques/i),
    ).toBeNull();
  });

  it('signale la divergence après le blur du champ de confirmation', () => {
    const { motDePasse, confirmation } = setup();

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    fireEvent.change(confirmation, { target: { value: 'autre-chose' } });
    fireEvent.blur(confirmation);

    expect(
      screen.getByText('Les deux mots de passe ne sont pas identiques.'),
    ).toBeInTheDocument();
  });

  it('efface le message dès que les deux champs coïncident', () => {
    const { motDePasse, confirmation } = setup();

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    fireEvent.change(confirmation, { target: { value: 'autre-chose' } });
    fireEvent.blur(confirmation);
    expect(screen.getByText(/ne sont pas identiques/)).toBeInTheDocument();

    fireEvent.change(confirmation, { target: { value: VALIDE } });
    expect(screen.queryByText(/ne sont pas identiques/)).toBeNull();
  });

  it('ne considère pas deux champs vides comme une confirmation valide', () => {
    // Piège classique : `password === confirmation` est vrai pour deux
    // chaînes vides. Le composant exige `password.length > 0`.
    const { bouton } = setup();
    expect(bouton).toBeDisabled();
  });
});

describe('PasswordScreen — soumission', () => {
  it('remonte le mot de passe choisi quand tout est valide', () => {
    const { motDePasse, confirmation, bouton, onSubmit } = setup();

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    fireEvent.change(confirmation, { target: { value: VALIDE } });
    fireEvent.click(bouton);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(VALIDE);
  });

  it('n’appelle jamais onSubmit avec une confirmation divergente', () => {
    const { motDePasse, confirmation, onSubmit } = setup();

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    fireEvent.change(confirmation, { target: { value: 'Motdepasse2' } });
    // On force la soumission du formulaire, en contournant le bouton désactivé :
    // c'est ce que ferait la touche Entrée ou un DOM trafiqué.
    fireEvent.submit(screen.getByRole('button', { name: /Créer mon accès/i }).closest('form')!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('n’appelle jamais onSubmit avec un mot de passe faible', () => {
    const { motDePasse, confirmation, onSubmit } = setup();

    fireEvent.change(motDePasse, { target: { value: 'faible' } });
    fireEvent.change(confirmation, { target: { value: 'faible' } });
    fireEvent.submit(
      screen.getByRole('button', { name: /Créer mon accès/i }).closest('form')!,
    );

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('bloque la double soumission pendant l’envoi (submitting)', () => {
    // Sans ce garde-fou, un double clic crée deux appels de création de
    // compte concurrents côté serveur.
    const { motDePasse, confirmation, bouton, onSubmit } = setup({
      submitting: true,
    });

    fireEvent.change(motDePasse, { target: { value: VALIDE } });
    fireEvent.change(confirmation, { target: { value: VALIDE } });

    expect(bouton).toBeDisabled();
    fireEvent.submit(bouton.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('PasswordScreen — contexte et erreurs serveur', () => {
  it('affiche l’erreur serveur transmise par la page', () => {
    setup({ error: 'Ce lien d’activation n’est plus valide.' });
    expect(
      screen.getByText('Ce lien d’activation n’est plus valide.'),
    ).toBeInTheDocument();
  });

  it('n’affiche aucune alerte quand error vaut null', () => {
    setup({ error: null });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rappelle l’espace et l’identifiant, non modifiables', () => {
    setup();
    expect(screen.getByText(/Atelier Dubois/)).toBeInTheDocument();
    expect(
      screen.getByText(/claire\.dubois@exemple-client\.fr/),
    ).toBeInTheDocument();
    // L'email vient du lien signé : aucun champ ne doit permettre de le changer.
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });
});

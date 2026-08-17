/**
 * Tests de `RecapScreen` — l'écran où se joue la conversion.
 *
 * Le client vient éventuellement de déclarer une refonte plus une
 * prospection, soit le panier le plus cher du catalogue. L'écran lui
 * répondait une liste de cartes grises et un bouton « Découvrir mon
 * espace » : aucun moyen de parler à quelqu'un, aucun créneau, aucune
 * promesse de rappel. C'était le trou le plus cher de tout l'onboarding — la
 * qualification faisait son travail, la conversion était à zéro.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { RecapScreen } from '@/components/onboarding/qualification/RecapScreen';
import { ecransPertinents } from '@/components/onboarding/qualification/questions';
import type {
  OnboardingUser,
  Qualification,
} from '@/components/onboarding/qualification/types';

const USER: OnboardingUser = {
  prenom: 'Claire',
  email: 'claire@exemple.fr',
  workspaceName: 'Atelier Dubois',
};

/** Le parcours le plus cher : refonte + contacts + prospection prioritaire. */
const AVEC_CHANTIER: Qualification = {
  siteActuel: 'oui',
  intentionSiteExistant: 'refonte',
  emailing: 'liste-existante',
  prospection: 'priorite',
  echeance: 'urgent',
};

/** Que des apps : rien à cadrer au téléphone. */
const SANS_CHANTIER: Qualification = {
  emailing: 'depuis-zero',
  prospection: 'explorer',
};

function afficher(
  qualification: Qualification,
  props: Partial<React.ComponentProps<typeof RecapScreen>> = {},
) {
  return render(
    <RecapScreen
      user={USER}
      qualification={qualification}
      ecrans={ecransPertinents(qualification)}
      onEnter={vi.fn()}
      {...props}
    />,
  );
}

describe('RecapScreen — la conversion quand un chantier est déclaré', () => {
  it('propose un créneau avec Robert', () => {
    afficher(AVEC_CHANTIER);
    const rdv = screen.getByRole('link', { name: /Réserver 15 minutes avec Robert/i });
    expect(rdv).toHaveAttribute('href', expect.stringContaining('cal.com'));
  });

  it('présente Robert comme un interlocuteur, avec sa ville', () => {
    // Sur six écrans, il n'y avait pas un prénom, pas un visage, pas une
    // ville : le ton était celui d'un SaaS anonyme, alors que l'atout numéro
    // un face aux plateformes est justement qu'il y a un humain derrière.
    afficher(AVEC_CHANTIER);
    expect(screen.getByText(/Robert, votre interlocuteur chez Veridian, Lyon/)).toBeInTheDocument();
  });

  it('fait passer « Découvrir mon espace » en action secondaire', () => {
    afficher(AVEC_CHANTIER);
    const espace = screen.getByRole('button', { name: /Découvrir mon espace/i });
    // Le variant `outline` : le rendez-vous est le bouton principal.
    expect(espace.className).toContain('border');
    expect(espace.className).not.toContain('cta-gradient');
  });
});

describe('RecapScreen — sortie de secours sans chantier', () => {
  it('n’affiche pas de créneau mais propose d’écrire à Robert', () => {
    afficher(SANS_CHANTIER);
    expect(screen.queryByRole('link', { name: /Réserver/i })).toBeNull();
    expect(screen.getByRole('link', { name: /Écrivez à Robert/i })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:'),
    );
  });

  it('garde « Découvrir mon espace » en action principale', () => {
    afficher(SANS_CHANTIER);
    expect(
      screen.getByRole('button', { name: /Découvrir mon espace/i }).className,
    ).toContain('cta-gradient');
  });
});

describe('RecapScreen — hiérarchie et honnêteté du texte', () => {
  it('n’étiquette plus un chantier avec une pastille grise « Projet »', () => {
    // La ligne à plusieurs milliers d'euros avait l'air moins importante et
    // moins concrète que « Veridian Analytics », qui est gratuit.
    afficher(AVEC_CHANTIER);
    expect(screen.queryByText('Projet')).toBeNull();
    expect(screen.getByText('On en parle ensemble')).toBeInTheDocument();
  });

  it('ne promet pas de « mettre en place » une refonte en cliquant', () => {
    afficher(AVEC_CHANTIER);
    expect(screen.queryByText(/on met en place/i)).toBeNull();
    expect(screen.getByText(/et ce qu’on cadre ensemble/)).toBeInTheDocument();
  });

  it('adapte le sous-titre quand il n’y a que des apps', () => {
    afficher(SANS_CHANTIER);
    expect(screen.getByText(/Voici ce qu’on active pour vous, Claire\./)).toBeInTheDocument();
  });
});

describe('RecapScreen — restitution et correction des réponses', () => {
  it('rappelle ce que le client a répondu', () => {
    // L'écran n'affichait QUE les recommandations. Selon le chemin, quatre
    // questions pouvaient ne produire qu'une seule ligne : la récompense
    // finale paraissait dérisoire au regard de l'effort demandé.
    afficher(AVEC_CHANTIER);
    expect(screen.getByText('Ce que vous nous avez dit')).toBeInTheDocument();
    expect(screen.getByText('Le refaire')).toBeInTheDocument();
    expect(screen.getByText('Oui, c’est ma priorité')).toBeInTheDocument();
  });

  it('rend chaque réponse cliquable pour revenir la corriger', () => {
    const onModifier = vi.fn();
    afficher(AVEC_CHANTIER, { onModifier });

    fireEvent.click(screen.getByRole('button', { name: /Avez-vous déjà un site web/i }));
    expect(onModifier).toHaveBeenCalledWith('site-actuel');
  });

  it('n’affiche pas de section vide quand aucune réponse n’est fournie', () => {
    afficher(SANS_CHANTIER, { ecrans: undefined });
    expect(screen.queryByText('Ce que vous nous avez dit')).toBeNull();
  });
});

describe('RecapScreen — échec de sauvegarde', () => {
  it('le signale au client sans le paniquer', () => {
    // `onTerminer` était appelé de façon synchrone, sans état : si l'écriture
    // Prisma échouait, le client voyait quand même les confettis et le
    // récapitulatif, et personne ne savait que ses réponses étaient perdues.
    afficher(AVEC_CHANTIER, { enregistrement: 'erreur' });
    const alerte = screen.getByRole('alert');
    expect(alerte).toHaveTextContent(/n’ont pas pu être enregistrées/);
    expect(alerte).toHaveTextContent(/Rien n’est perdu/);
  });

  it('n’affiche aucune alerte quand tout va bien', () => {
    afficher(AVEC_CHANTIER);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

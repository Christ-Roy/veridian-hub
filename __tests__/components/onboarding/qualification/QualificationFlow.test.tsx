/**
 * Tests d'intégration du parcours de qualification.
 *
 * On parcourt les deux branches jusqu'au récapitulatif comme le ferait un
 * client, et on vérifie la charge remontée à `onTerminer` — c'est elle qui
 * partira en base au branchement.
 *
 * Trois régressions y sont verrouillées, toutes invisibles à l'œil :
 *   - la reprise de parcours, annoncée partout et implémentée nulle part ;
 *   - le focus perdu à chaque changement d'écran ;
 *   - l'absence totale de sauvegarde intermédiaire.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import {
  QualificationFlow,
  indexDeReprise,
} from '@/components/onboarding/qualification/QualificationFlow';
import type {
  OnboardingUser,
  Qualification,
  UserOnboardingRecord,
} from '@/components/onboarding/qualification/types';

const USER: OnboardingUser = {
  prenom: 'Claire',
  email: 'claire.dubois@exemple-client.fr',
  workspaceName: 'Atelier Dubois',
};

const VIERGE: UserOnboardingRecord = {
  userId: 'usr_test',
  invitedAt: '2026-07-20T09:00:00.000Z',
  activatedAt: '2026-07-28T08:30:00.000Z',
  firstAppStartedAt: null,
  memberInvitedAt: null,
  workspaceRenamedAt: null,
  completedAt: null,
  metadata: null,
};

const avec = (qualification: Qualification): UserOnboardingRecord => ({
  ...VIERGE,
  metadata: { qualification },
});

/** Clique l'option portant ce libellé dans le groupe de réponses. */
function repondre(label: RegExp) {
  fireEvent.click(screen.getByRole('radio', { name: label }));
}

describe('QualificationFlow — parcours « j’ai déjà un site »', () => {
  it('mène du premier écran au récapitulatif et remonte les réponses', () => {
    const onTerminer = vi.fn();
    render(
      <QualificationFlow user={USER} etat={VIERGE} onTerminer={onTerminer} />,
    );

    // Accueil : aucune réponse en base, on part du contrat.
    fireEvent.click(screen.getByRole('button', { name: /C’est parti/i }));

    repondre(/Oui, j’ai un site/);
    repondre(/Le refaire/);
    repondre(/Oui, j’ai déjà des contacts/);
    repondre(/Oui, c’est ma priorité/);
    // La refonte a ouvert la question d'échéance.
    repondre(/Le plus tôt possible/);

    expect(onTerminer).toHaveBeenCalledTimes(1);
    const charge = onTerminer.mock.calls[0][0] as UserOnboardingRecord;
    expect(charge.metadata?.qualification).toEqual({
      siteActuel: 'oui',
      intentionSiteExistant: 'refonte',
      emailing: 'liste-existante',
      prospection: 'priorite',
      echeance: 'urgent',
    });
    expect(charge.completedAt).toEqual(expect.any(String));
    expect(charge.metadata?.etapeCourante).toBe('recapitulatif');
  });
});

describe('QualificationFlow — parcours « je n’ai pas de site »', () => {
  it('emprunte l’autre branche et n’ajoute pas l’échéance sans chantier daté', () => {
    const onTerminer = vi.fn();
    render(
      <QualificationFlow user={USER} etat={VIERGE} onTerminer={onTerminer} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /C’est parti/i }));
    repondre(/Non, pas encore/);

    // La question posée est bien celle de l'autre branche.
    expect(
      screen.getByRole('heading', { level: 1, name: /vous servirait le plus/i }),
    ).toBeInTheDocument();

    repondre(/Je ne sais pas encore/);
    repondre(/Plus tard/);
    repondre(/Je vends aux particuliers/);
    // « Je ne sais pas encore » déclenche un chantier daté → échéance.
    repondre(/Pas de date/);

    const charge = onTerminer.mock.calls[0][0] as UserOnboardingRecord;
    expect(charge.metadata?.qualification).toEqual({
      siteActuel: 'non',
      intentionSansSite: 'indecis',
      emailing: 'plus-tard',
      prospection: 'b2c',
      echeance: 'sans-date',
    });
  });
});

describe('QualificationFlow — reprise de parcours', () => {
  // 🔴 L'index démarrait EN DUR à -1. Un client qui répondait à deux
  // questions et fermait l'onglet retombait sur l'accueil et devait tout
  // recliquer : c'est le scénario type de la première connexion interrompue,
  // et le premier motif d'abandon définitif.

  it('indexDeReprise renvoie l’accueil quand rien n’a été répondu', () => {
    expect(indexDeReprise(VIERGE)).toBe(-1);
    expect(indexDeReprise(avec({}))).toBe(-1);
  });

  it('indexDeReprise vise la première question sans réponse', () => {
    // 3 écrans pertinents (site-actuel, emailing, prospection) + la branche.
    expect(indexDeReprise(avec({ siteActuel: 'oui' }))).toBe(1);
    expect(
      indexDeReprise(avec({ siteActuel: 'oui', intentionSiteExistant: 'refonte' })),
    ).toBe(2);
  });

  it('indexDeReprise vise le récapitulatif quand tout est répondu', () => {
    const complet = avec({
      siteActuel: 'oui',
      intentionSiteExistant: 'satisfait',
      emailing: 'plus-tard',
      prospection: 'plus-tard',
    });
    // 4 écrans (pas d'échéance : « satisfait » n'est pas un chantier daté).
    expect(indexDeReprise(complet)).toBe(4);
  });

  it('n’affiche PAS l’accueil à un client qui a déjà commencé', () => {
    render(<QualificationFlow user={USER} etat={avec({ siteActuel: 'oui' })} />);

    expect(screen.queryByText(/Bienvenue Claire/)).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: /Qu’aimeriez-vous en faire/i }),
    ).toBeInTheDocument();
  });

  it('ouvre directement le récapitulatif quand tout est déjà répondu', () => {
    render(
      <QualificationFlow
        user={USER}
        etat={avec({
          siteActuel: 'oui',
          intentionSiteExistant: 'refonte',
          emailing: 'liste-existante',
          prospection: 'priorite',
          echeance: 'urgent',
        })}
      />,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: /Votre espace est prêt/i }),
    ).toBeInTheDocument();
  });
});

describe('QualificationFlow — sauvegarde intermédiaire', () => {
  it('appelle onRepondre à CHAQUE réponse, avec l’étape en cours', () => {
    // Sans ça, un client qui répond à deux questions sur quatre et ferme
    // l'onglet ne laisse aucune trace en base — alors que le funnel « qui a
    // commencé sans finir » est exactement ce qui motive `user_onboarding`.
    const onRepondre = vi.fn();
    render(<QualificationFlow user={USER} etat={VIERGE} onRepondre={onRepondre} />);

    fireEvent.click(screen.getByRole('button', { name: /C’est parti/i }));
    repondre(/Oui, j’ai un site/);

    expect(onRepondre).toHaveBeenCalledTimes(1);
    const charge = onRepondre.mock.calls[0][0] as UserOnboardingRecord;
    expect(charge.metadata?.qualification).toEqual({
      siteActuel: 'oui',
      intentionSiteExistant: undefined,
      intentionSansSite: undefined,
    });
    // L'étape pointée est bien la SUIVANTE, celle qu'il faudra rouvrir.
    expect(charge.metadata?.etapeCourante).toBe('site-intention-existant');
    expect(charge.completedAt).toBeNull();
  });
});

describe('QualificationFlow — clavier et lecteurs d’écran', () => {
  it('donne le focus au titre du nouvel écran après une réponse', () => {
    // Changer une `key` React ne déplace JAMAIS le focus : après un clic, le
    // focus tombait sur `document.body` et le Tab suivant repartait du tout
    // début du document.
    render(<QualificationFlow user={USER} etat={VIERGE} />);
    fireEvent.click(screen.getByRole('button', { name: /C’est parti/i }));
    repondre(/Oui, j’ai un site/);

    const titre = screen.getByRole('heading', {
      level: 1,
      name: /Qu’aimeriez-vous en faire/i,
    });
    expect(document.activeElement).toBe(titre);
  });

  it('groupe les réponses en radiogroup relié au titre de la question', () => {
    render(<QualificationFlow user={USER} etat={avec({ siteActuel: 'oui' })} />);

    const groupe = screen.getByRole('radiogroup');
    const titre = screen.getByRole('heading', { level: 1 });
    expect(groupe).toHaveAttribute('aria-labelledby', titre.id);
    expect(within(groupe).getAllByRole('radio')).toHaveLength(3);
  });

  it('n’expose qu’UN seul arrêt de tabulation pour tout le groupe', () => {
    // Focus roving : sans lui, il faut tabuler option par option.
    render(<QualificationFlow user={USER} etat={avec({ siteActuel: 'oui' })} />);

    const radios = screen.getAllByRole('radio');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('sélectionne aux flèches puis avance, comme un groupe radio natif', () => {
    render(<QualificationFlow user={USER} etat={avec({ siteActuel: 'oui' })} />);

    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: 'ArrowDown' });

    // La flèche choisit « Le refaire », puis l'auto-avance donne le focus au
    // titre suivant. Déplacer seulement le focus sans cocher aurait violé le
    // comportement attendu d'un `radiogroup` ARIA.
    const titreSuivant = screen.getByRole('heading', {
      level: 1,
      name: /Vous gardez le contact avec vos clients/i,
    });
    expect(document.activeElement).toBe(titreSuivant);
  });

  it('annonce le changement d’écran dans une zone aria-live', () => {
    const { container } = render(
      <QualificationFlow user={USER} etat={avec({ siteActuel: 'oui' })} />,
    );

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/Qu’aimeriez-vous en faire/);
  });
});

describe('QualificationFlow — retour en arrière', () => {
  it('garde un « Retour » sur le récapitulatif', () => {
    // Le pied n'était affiché que sur les questions : le client qui
    // s'apercevait d'un mauvais clic n'avait plus AUCUN moyen de revenir.
    render(
      <QualificationFlow
        user={USER}
        etat={avec({
          siteActuel: 'oui',
          intentionSiteExistant: 'satisfait',
          emailing: 'plus-tard',
          prospection: 'plus-tard',
        })}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: /espace est prêt/i }));
    fireEvent.click(screen.getByRole('button', { name: /Retour/i }));
    expect(
      screen.getByRole('heading', { level: 1, name: /clients professionnels/i }),
    ).toBeInTheDocument();
  });

  it('permet de corriger une réponse depuis le récapitulatif', () => {
    render(
      <QualificationFlow
        user={USER}
        etat={avec({
          siteActuel: 'oui',
          intentionSiteExistant: 'satisfait',
          emailing: 'plus-tard',
          prospection: 'plus-tard',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Avez-vous déjà un site web/i }));
    expect(
      screen.getByRole('heading', { level: 1, name: /Avez-vous déjà un site web/i }),
    ).toBeInTheDocument();
  });
});

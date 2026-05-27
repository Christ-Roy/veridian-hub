/**
 * Tests pour components/landing/features-section.tsx — bloc landing qui
 * présente CRM + Mail Automation.
 *
 * Aligné sur la décision du sprint hub-crm-v1-staging (2026-05-27) :
 *  - le bloc CRM RESTE (on a maintenant un backend en staging)
 *  - copy adapté : Pipeline Kanban + Contacts/AI + Import depuis Prospection
 *  - mention "Inclus dans Veridian Pro & Business"
 *  - badge soft "Disponible sur staging — lancement prod imminent"
 *  - CTA "Découvrir l'offre CRM" → /pricing#crm
 *
 * Quand le CRM sera promu en prod, le badge "Disponible sur staging" sera
 * retiré (cf todo/2026-05-27-hub-landing-crm-coherence.md).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeaturesSection } from '@/components/landing/features-section';

describe('FeaturesSection — bloc CRM aligné staging', () => {
  it('rend bien le titre "CRM Intelligent"', () => {
    render(<FeaturesSection />);
    expect(screen.getByText(/CRM Intelligent/i)).toBeInTheDocument();
  });

  it('affiche le rattachement à l\'offre payante "Inclus dans Veridian Pro & Business"', () => {
    render(<FeaturesSection />);
    expect(
      screen.getByText(/Inclus dans Veridian Pro & Business/i),
    ).toBeInTheDocument();
  });

  it('affiche le badge transitoire "Disponible sur staging — lancement prod imminent"', () => {
    render(<FeaturesSection />);
    expect(
      screen.getByText(/Disponible sur staging — lancement prod imminent/i),
    ).toBeInTheDocument();
  });

  it('liste les 3 features alignées sur le livrable v1 (Pipeline Kanban, Contacts & IA, Import Prospection)', () => {
    render(<FeaturesSection />);
    expect(screen.getByText('Pipeline Kanban')).toBeInTheDocument();
    expect(screen.getByText(/Contacts & assistant IA/i)).toBeInTheDocument();
    expect(screen.getByText(/Import depuis Prospection/i)).toBeInTheDocument();
  });

  it('expose un CTA "Découvrir l\'offre CRM" qui pointe vers /pricing#crm', () => {
    render(<FeaturesSection />);
    const cta = screen.getByRole('link', { name: /Découvrir l'offre CRM/i });
    expect(cta).toBeInTheDocument();
    expect(cta.getAttribute('href')).toBe('/pricing#crm');
  });

  it('mentionne l\'intégration avec Veridian Prospection dans la description', () => {
    render(<FeaturesSection />);
    // Le copy doit faire le lien avec Prospection (autre app du SaaS) pour
    // matérialiser le pitch cross-app — pas juste un CRM générique.
    const body = document.body.textContent || '';
    expect(body).toMatch(/Prospection/);
  });

  it('garde le bloc Mail Automation à côté du CRM (les 2 services MVP)', () => {
    render(<FeaturesSection />);
    expect(screen.getByText('Mail Automation')).toBeInTheDocument();
    expect(screen.getByText('Campagnes automatisées')).toBeInTheDocument();
  });

  it('n\'expose plus l\'ancien copy générique "Gestion des contacts" / "Pipeline de ventes" / "Analytics avancés"', () => {
    render(<FeaturesSection />);
    // Ces 3 titres pré-staging-CRM (générique freemium) ont été remplacés
    // par le copy aligné v1. Garde anti-régression au cas où on réintroduit
    // l'ancienne version par erreur.
    expect(screen.queryByText('Gestion des contacts')).toBeNull();
    expect(screen.queryByText('Pipeline de ventes')).toBeNull();
    expect(screen.queryByText('Analytics avancés')).toBeNull();
  });
});

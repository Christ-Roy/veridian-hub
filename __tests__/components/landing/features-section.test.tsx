/**
 * Tests pour components/landing/features-section.tsx — bloc landing qui
 * présente Veridian CRM + Mail Automation.
 *
 * Aligné sur la décision du sprint hub-crm-v1-staging (2026-05-27) en mode
 * PLAN-AGNOSTIC : l'offre commerciale CRM (tier pricing, claims features
 * fermes) n'est pas encore tranchée — cf todo/2026-05-27-review-offre-crm-veridian.md.
 *
 * Donc le bloc doit rester sobre :
 *  - Titre "Veridian CRM"
 *  - Badges "Bientôt disponible" + "En cours de déploiement"
 *  - Mention "Pipeline contacts, intégrations natives, AI assistant"
 *  - CTA "Découvrir l'offre" → /pricing (PAS d'ancre #crm, PAS de tier nommé)
 *  - PAS de rattachement Pro/Business
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeaturesSection } from '@/components/landing/features-section';

describe('FeaturesSection — bloc CRM (mode plan-agnostic)', () => {
  it('rend bien le titre "Veridian CRM"', () => {
    render(<FeaturesSection />);
    expect(screen.getByText(/Veridian CRM/i)).toBeInTheDocument();
  });

  it('affiche le badge "Bientôt disponible"', () => {
    render(<FeaturesSection />);
    expect(screen.getByText(/Bientôt disponible/i)).toBeInTheDocument();
  });

  it('affiche le badge transitoire "En cours de déploiement"', () => {
    render(<FeaturesSection />);
    expect(screen.getByText(/En cours de déploiement/i)).toBeInTheDocument();
  });

  it('mentionne la trio "Pipeline contacts, intégrations natives, AI assistant" dans la description', () => {
    render(<FeaturesSection />);
    const body = document.body.textContent || '';
    expect(body).toMatch(/Pipeline contacts/i);
    expect(body).toMatch(/intégrations natives/i);
    expect(body).toMatch(/AI assistant/i);
  });

  it('liste les 3 cards CRM (Pipeline contacts / Intégrations natives / AI assistant)', () => {
    render(<FeaturesSection />);
    expect(screen.getByText('Pipeline contacts')).toBeInTheDocument();
    expect(screen.getByText('Intégrations natives')).toBeInTheDocument();
    expect(screen.getByText('AI assistant')).toBeInTheDocument();
  });

  it('expose un CTA "Découvrir l\'offre" qui pointe vers /pricing (sans ancre)', () => {
    render(<FeaturesSection />);
    const cta = screen.getByRole('link', { name: /Découvrir l'offre/i });
    expect(cta).toBeInTheDocument();
    expect(cta.getAttribute('href')).toBe('/pricing');
  });

  it('N\'expose AUCUN rattachement à un tier pricing nommé (Pro/Business)', () => {
    // L'offre commerciale CRM n'est pas tranchée — ne pas pré-engager
    // le marketing sur "Inclus dans Veridian Pro & Business".
    render(<FeaturesSection />);
    const body = document.body.textContent || '';
    expect(body).not.toMatch(/Inclus dans Veridian Pro/i);
    expect(body).not.toMatch(/Inclus dans Pro & Business/i);
  });

  it('N\'expose AUCUNE ancre #crm dans les liens CTA (offre pas encore figée côté /pricing)', () => {
    render(<FeaturesSection />);
    const links = screen.getAllByRole('link');
    for (const link of links) {
      expect(link.getAttribute('href')).not.toMatch(/#crm/);
    }
  });

  it('garde le bloc Mail Automation à côté du CRM (les 2 services MVP)', () => {
    render(<FeaturesSection />);
    expect(screen.getByText('Mail Automation')).toBeInTheDocument();
    expect(screen.getByText('Campagnes automatisées')).toBeInTheDocument();
  });

  it('n\'expose plus l\'ancien copy générique "Gestion des contacts" / "Pipeline de ventes" / "Analytics avancés"', () => {
    render(<FeaturesSection />);
    expect(screen.queryByText('Gestion des contacts')).toBeNull();
    expect(screen.queryByText('Pipeline de ventes')).toBeNull();
    expect(screen.queryByText('Analytics avancés')).toBeNull();
  });
});

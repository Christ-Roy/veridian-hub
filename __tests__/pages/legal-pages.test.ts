/**
 * Tests de non-régression sur les 3 pages légales : /privacy, /terms, /legal.
 *
 * Pourquoi ce test, hors-scope mode Nuclear :
 *   - Ces pages servent de référence pour Google OAuth Consent Screen,
 *     Microsoft Entra Publisher Verification, Stripe Compliance.
 *   - Si un dev supprime accidentellement la mention RGPD, ou retire
 *     l'identification des sous-traitants Google/Microsoft, on viole
 *     le RGPD ET on peut se faire rejeter une brand verification.
 *   - Le test lit le source TSX et vérifie la présence des termes
 *     obligatoires. Pas de rendu DOM (overkill pour des pages statiques),
 *     c'est suffisant pour bloquer un nettoyage trop zélé.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PRIVACY_PATH = resolve(
  __dirname,
  '../../app/(marketing)/privacy/page.tsx',
);
const TERMS_PATH = resolve(
  __dirname,
  '../../app/(marketing)/terms/page.tsx',
);
const LEGAL_PATH = resolve(
  __dirname,
  '../../app/(marketing)/legal/page.tsx',
);

describe('/privacy page', () => {
  it('existe', () => {
    expect(existsSync(PRIVACY_PATH)).toBe(true);
  });

  describe('contenu obligatoire RGPD', () => {
    const src = existsSync(PRIVACY_PATH) ? readFileSync(PRIVACY_PATH, 'utf-8') : '';

    it('mentionne RGPD', () => {
      expect(src).toMatch(/RGPD/);
    });

    it("mentionne l'identité de l'éditeur Veridian (SIREN)", () => {
      expect(src).toContain('980 837 660');
    });

    it('expose les scopes OAuth Google utilisés (openid email profile)', () => {
      expect(src).toMatch(/openid/i);
      expect(src).toMatch(/\bemail\b/);
      expect(src).toMatch(/\bprofile\b/);
    });

    it('précise que les scopes Google sont limités (PAS Gmail/Drive/Calendar)', () => {
      expect(src).toMatch(/n['']accède PAS.*Gmail/i);
    });

    it('précise que les scopes Microsoft sont limités (PAS Outlook/OneDrive/Teams)', () => {
      expect(src).toMatch(/n['']accède PAS.*Outlook/i);
    });

    it('mentionne les droits utilisateurs (accès, rectification, effacement, portabilité)', () => {
      expect(src).toMatch(/accès/);
      expect(src).toMatch(/rectification/);
      expect(src).toMatch(/effacement/);
      expect(src).toMatch(/portabilité/);
    });

    it('cite les sous-traitants actuels (Stripe, Google, Microsoft, Cloudflare, OVH)', () => {
      expect(src).toMatch(/Stripe/);
      expect(src).toMatch(/Google/);
      expect(src).toMatch(/Microsoft/);
      expect(src).toMatch(/Cloudflare/);
      expect(src).toMatch(/OVH/);
    });

    it("affirme l'absence de revente / partage publicitaire", () => {
      expect(src).toMatch(/JAMAIS revendues/);
      expect(src).toMatch(/publicitaire/i);
    });

    it("mentionne le droit de réclamation CNIL", () => {
      expect(src).toMatch(/CNIL/);
    });

    it("contient un email de contact valide (pas brunon5robert@gmail.com)", () => {
      // L'email officiel doit être @veridian.site (pas le gmail perso de Robert
      // qui traînait dans l'ancienne page combinée).
      expect(src).toMatch(/robert\.brunon@veridian\.site/);
      expect(src).not.toMatch(/brunon5robert@gmail\.com/);
    });

    it('a une URL canonique /privacy', () => {
      expect(src).toContain('app.veridian.site/privacy');
    });
  });
});

describe('/terms page', () => {
  it('existe', () => {
    expect(existsSync(TERMS_PATH)).toBe(true);
  });

  describe('contenu obligatoire CGU/CGV', () => {
    const src = existsSync(TERMS_PATH) ? readFileSync(TERMS_PATH, 'utf-8') : '';

    it("mentionne le droit de rétractation 14 jours (L221-18 Code conso)", () => {
      expect(src).toMatch(/14.*jours/);
      expect(src).toMatch(/L221-18/);
    });

    it('mentionne Stripe pour le paiement', () => {
      expect(src).toMatch(/Stripe/);
    });

    it('cite les méthodes de signup (email/password, Google, Microsoft)', () => {
      expect(src).toMatch(/Google/);
      expect(src).toMatch(/Microsoft/);
      expect(src).toMatch(/mot de passe/);
    });

    it('précise la juridiction française', () => {
      expect(src).toMatch(/droit français/);
      expect(src).toMatch(/tribunaux/i);
    });

    it("contient un email de contact valide (pas brunon5robert@gmail.com)", () => {
      expect(src).toMatch(/robert\.brunon@veridian\.site/);
      expect(src).not.toMatch(/brunon5robert@gmail\.com/);
    });

    it('a une URL canonique /terms', () => {
      expect(src).toContain('app.veridian.site/terms');
    });

    it('lie vers /privacy pour la protection des données', () => {
      expect(src).toMatch(/href="\/privacy"|\/privacy[\s"']/);
    });
  });
});

describe('/legal page', () => {
  it('existe', () => {
    expect(existsSync(LEGAL_PATH)).toBe(true);
  });

  describe('mentions légales (LCEN art. 6)', () => {
    const src = existsSync(LEGAL_PATH) ? readFileSync(LEGAL_PATH, 'utf-8') : '';

    it('identifie clairement Veridian comme éditeur', () => {
      expect(src).toMatch(/Veridian/);
      expect(src).toMatch(/980 837 660/); // SIREN
    });

    it('identifie OVH comme hébergeur', () => {
      expect(src).toMatch(/OVH/);
      expect(src).toMatch(/Roubaix/);
    });

    it("expose le directeur de la publication", () => {
      expect(src).toMatch(/[Dd]irecteur de la publication/);
    });

    it('a une procédure de signalement de contenu illicite (LCEN)', () => {
      expect(src).toMatch(/LCEN/);
    });

    it("lie vers /privacy et /terms", () => {
      expect(src).toMatch(/\/privacy/);
      expect(src).toMatch(/\/terms/);
    });

    it("contient un email de contact valide (pas brunon5robert@gmail.com)", () => {
      expect(src).toMatch(/robert\.brunon@veridian\.site/);
      expect(src).not.toMatch(/brunon5robert@gmail\.com/);
    });

    it('a une URL canonique /legal', () => {
      expect(src).toContain('app.veridian.site/legal');
    });

    it("conserve les ancres legacy pour ne pas casser les liens externes (#confidentialite, #cgv, #remboursement)", () => {
      // Anciennes ancres encore référencées potentiellement par Stripe/footers
      // archivés/Google Search → on les garde en redirections internes.
      expect(src).toMatch(/id="confidentialite"/);
      expect(src).toMatch(/id="cgv"/);
      expect(src).toMatch(/id="remboursement"/);
    });
  });
});

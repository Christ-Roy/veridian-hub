/**
 * Smoke test source pour `/invite/[token]/page.tsx` — vérifie que la page
 * intègre bien les 3 composants client clés (cross-app, workspace, signin)
 * et le helper de validation du token.
 *
 * Approche : lecture du source (pas de render SSR car la page est async +
 * touche à Prisma — overkill pour un test smoke). Le rendu interactif réel
 * est couvert par les tests RTL colocalisés sur les 2 composants client
 * (`AcceptCrossAppInviteButton.test.tsx`, `InviteSignInOptions.test.tsx`)
 * et par le spec E2E Playwright `e2e/staging-full/11-ui-invite-flow.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(
  __dirname,
  '../../../../app/invite/[token]/page.tsx',
);
const ACCEPT_CROSS_PATH = resolve(
  __dirname,
  '../../../../app/invite/[token]/AcceptCrossAppInviteButton.tsx',
);
const SIGNIN_OPTIONS_PATH = resolve(
  __dirname,
  '../../../../app/invite/[token]/InviteSignInOptions.tsx',
);

describe('/invite/[token] page source', () => {
  it('le fichier page.tsx existe', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('les 2 nouveaux composants client existent', () => {
    expect(existsSync(ACCEPT_CROSS_PATH)).toBe(true);
    expect(existsSync(SIGNIN_OPTIONS_PATH)).toBe(true);
  });

  describe('intégration des composants', () => {
    const src = existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, 'utf-8') : '';

    it('importe AcceptCrossAppInviteButton', () => {
      expect(src).toMatch(
        /import\s*\{\s*AcceptCrossAppInviteButton\s*\}\s*from\s*['"]\.\/AcceptCrossAppInviteButton['"]/,
      );
    });

    it('importe InviteSignInOptions', () => {
      expect(src).toMatch(
        /import\s*\{\s*InviteSignInOptions\s*\}\s*from\s*['"]\.\/InviteSignInOptions['"]/,
      );
    });

    it('importe le legacy AcceptInviteButton (workspace invite)', () => {
      // Reste utilisé pour le flow workspace invite interne.
      expect(src).toMatch(/AcceptInviteButton/);
    });

    it('valide le token via crossAppInvitation (cross-app prioritaire)', () => {
      expect(src).toMatch(/prisma\.crossAppInvitation\.findUnique/);
    });

    it('valide le token via invitation (workspace fallback)', () => {
      expect(src).toMatch(/prisma\.invitation\.findUnique/);
    });

    it('rejette les tokens au mauvais format (regex 64 hex)', () => {
      expect(src).toMatch(/\[0-9a-f\]\{64\}/);
    });

    it("affiche les options de sign-in (OAuth + signup) si user non loggué", () => {
      expect(src).toMatch(/InviteSignInOptions[\s\S]*token=\{token\}/);
    });

    it('gate allowOauth via getAuthTypes (DEPLOY_ENV staging)', () => {
      expect(src).toMatch(/getAuthTypes/);
      expect(src).toMatch(/allowOauth/);
    });
  });
});

/**
 * Smoke source pour `app/dashboard/layout.tsx` — vérifie la régression
 * 2026-05-21 : le layout doit récupérer le workspace courant via Prisma
 * et le passer à `<AppSidebar workspaceName=... />`. Sans ça, l'objet
 * workspace n'est plus visible dans l'UI (le user ne sait pas qu'il
 * appartient à un workspace).
 *
 * Couvre :
 *   - import AppSidebar
 *   - query Prisma workspace.findFirst avec filter members
 *   - filter deletedAt: null (pas de soft-deleted)
 *   - prop workspaceName passé au composant
 *
 * Le rendu interactif du sidebar est couvert par
 * `__tests__/components/app-sidebar.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LAYOUT_PATH = resolve(
  __dirname,
  '../../../app/dashboard/layout.tsx',
);

describe('Dashboard layout — workspaceName prop sur AppSidebar', () => {
  it('le fichier layout.tsx existe', () => {
    expect(existsSync(LAYOUT_PATH)).toBe(true);
  });

  const src = existsSync(LAYOUT_PATH) ? readFileSync(LAYOUT_PATH, 'utf-8') : '';

  it('importe AppSidebar', () => {
    expect(src).toMatch(/import\s*\{\s*AppSidebar\s*\}\s*from/);
  });

  it('importe prisma', () => {
    expect(src).toMatch(/from\s*['"]@\/lib\/prisma['"]/);
  });

  it('résout le workspace courant via workspace.findFirst', () => {
    expect(src).toMatch(/prisma\.workspace\.findFirst/);
  });

  it('filtre les workspaces dont le user est membre', () => {
    expect(src).toMatch(/members:\s*\{\s*some:\s*\{\s*userId/);
  });

  it('ignore les workspaces soft-deleted', () => {
    expect(src).toMatch(/deletedAt:\s*null/);
  });

  it('passe workspaceName en prop à AppSidebar', () => {
    expect(src).toMatch(/workspaceName=\{currentWorkspaceName\}/);
  });

  it('gère le cas workspace introuvable sans crasher (null)', () => {
    // Le layout doit fallback sur null si findFirst retourne null.
    expect(src).toMatch(/currentWorkspaceName.*=.*null/);
  });
});

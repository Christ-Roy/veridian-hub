/**
 * Tests structuraux de `middleware.ts` — le middleware Auth.js v5 edge.
 *
 * **Pourquoi ces tests existent** : middleware.ts est dans le scope Nuclear
 * depuis 2026-05-21. Le fichier est trivial mais critique : il décide quelles
 * routes sont gardées par l'auth. Toute modif au `matcher` ou au branchement
 * NextAuth doit avoir une trace test.
 *
 * Les tests fonctionnels du callback `authorized()` sont dans
 * `auth-config.test.ts` (où vit la vraie logique). Ici on verrouille la
 * structure du middleware lui-même.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Static analysis — middleware.ts importe NextAuth qui dépend de next/server
// (pas résolvable dans Vitest sans setup). On vérifie la forme du source.
// Le runtime est validé par les E2E sur staging (auth-guards.spec.ts).
const source = fs.readFileSync(
  path.join(process.cwd(), 'middleware.ts'),
  'utf8',
);

describe('middleware.ts — exports edge-safe', () => {
  it('exporte middleware (alias auth) + config (matcher)', () => {
    expect(source).toMatch(/export\s+const\s+\{\s*auth:\s*middleware\s*\}\s*=\s*NextAuth\(/);
    expect(source).toMatch(/export\s+const\s+config\s*=\s*\{[\s\S]*?matcher:/);
  });
});

describe('middleware.ts — matcher exclusions', () => {
  it('exclut _next/static (sinon middleware tape sur tous les assets statiques)', () => {
    expect(source).toMatch(/_next\/static/);
  });

  it('exclut _next/image (sinon middleware tape sur l\'optimizer Next)', () => {
    expect(source).toMatch(/_next\/image/);
  });

  it('exclut favicon.ico (sinon middleware tape sur le favicon)', () => {
    expect(source).toMatch(/favicon\.ico/);
  });

  it('exclut les images statiques (svg|png|jpg|jpeg|gif|webp)', () => {
    expect(source).toMatch(/svg\|png\|jpg\|jpeg\|gif\|webp/);
  });

  it('utilise auth.config (PAS auth.ts) — edge-safe sans Prisma', () => {
    // Si quelqu'un importe @/auth dans middleware.ts, le middleware crashe
    // au démarrage (Prisma n'est pas edge-compatible). Ce test verrouille
    // l'invariant.
    expect(source).toMatch(/from\s+['"]@\/auth\.config['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/auth['"]/);
  });
});

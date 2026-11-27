import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Compteurs de débit et verrou des programmes : en mémoire pour les tests unitaires (aucune base). vi.mock survit à vi.resetModules,
// donc chaque copie de module garde le magasin mémoire. L'épreuve à deux instances désactive ces mocks (vi.unmock) pour la vraie base.
vi.mock('@/lib/auth/compteurs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/compteurs')>();
  mod.installerMagasin(mod.magasinEnMemoire());
  return mod;
});
vi.mock('@/lib/mcp/verrou-programme', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/mcp/verrou-programme')>();
  mod.installerVerrou(mod.verrouEnMemoire());
  return mod;
});

// Mock global de canvas-confetti : la vraie lib lance une animation via
// requestAnimationFrame qui survit au teardown des tests et plante sur
// `clearRect` (pas de vrai <canvas> en happy-dom) → "Unhandled Error" qui
// fait échouer vitest même quand les assertions passent. Les composants qui
// célèbrent (OnboardingChecklist, StartTrialButton via lib/confetti) sont
// rendus dans plusieurs specs : on neutralise l'animation partout.
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

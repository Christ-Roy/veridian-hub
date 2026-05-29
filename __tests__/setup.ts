import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock global de canvas-confetti : la vraie lib lance une animation via
// requestAnimationFrame qui survit au teardown des tests et plante sur
// `clearRect` (pas de vrai <canvas> en happy-dom) → "Unhandled Error" qui
// fait échouer vitest même quand les assertions passent. Les composants qui
// célèbrent (OnboardingChecklist, StartTrialButton via lib/confetti) sont
// rendus dans plusieurs specs : on neutralise l'animation partout.
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

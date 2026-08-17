import { describe, expect, it } from 'vitest';

import {
  generateOnboardingToken,
  hashOnboardingToken,
  onboardingIdentifier,
  userIdFromOnboardingIdentifier,
} from '@/lib/onboarding/tokens';

describe('onboarding tokens', () => {
  it('génère un token URL-safe et un hash SHA-256 déterministe', () => {
    const token = generateOnboardingToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashOnboardingToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOnboardingToken(token)).toBe(hashOnboardingToken(token));
    expect(hashOnboardingToken(token)).not.toBe(token);
  });

  it('encode le préfixe onboard:<userId>', () => {
    expect(onboardingIdentifier('user_123')).toBe('onboard:user_123');
    expect(userIdFromOnboardingIdentifier('onboard:user_123')).toBe('user_123');
    expect(userIdFromOnboardingIdentifier('reset:user_123')).toBeNull();
  });
});

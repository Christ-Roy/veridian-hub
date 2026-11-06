import { describe, expect, it } from 'vitest';

import {
  ONBOARDING_TOKEN_IDENTIFIER_PREFIX,
  ONBOARDING_TOKEN_TTL_DAYS,
  ONBOARDING_TOKEN_TTL_MS,
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

  it('exporte un préfixe dédié qui isole les tokens onboarding des autres flows', () => {
    expect(ONBOARDING_TOKEN_IDENTIFIER_PREFIX).toBe('onboard:');
    expect(onboardingIdentifier('u_1').startsWith(ONBOARDING_TOKEN_IDENTIFIER_PREFIX)).toBe(true);
  });

  it('fixe une durée de vie de 14 jours cohérente en millisecondes', () => {
    expect(ONBOARDING_TOKEN_TTL_DAYS).toBe(14);
    expect(ONBOARDING_TOKEN_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('refuse un identifier onboard sans userId', () => {
    expect(userIdFromOnboardingIdentifier('onboard:')).toBeNull();
  });

  it('préserve les userId qui contiennent eux-mêmes des deux-points', () => {
    expect(userIdFromOnboardingIdentifier('onboard:tenant:user:123')).toBe('tenant:user:123');
  });

  it('génère deux tokens indépendants successifs', () => {
    const first = generateOnboardingToken();
    const second = generateOnboardingToken();
    expect(first).not.toBe(second);
  });

  it('hash le token complet en UTF-8 sans normalisation métier', () => {
    expect(hashOnboardingToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', // check-no-secrets:allow — vecteur SHA-256 de "abc", pas un secret
    );
    expect(hashOnboardingToken('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c', // check-no-secrets:allow — vecteur SHA-256 de "é", pas un secret
    );
  });

  it('ne confond jamais un hash avec un identifier stockable', () => {
    const token = generateOnboardingToken();
    expect(hashOnboardingToken(token)).not.toContain(ONBOARDING_TOKEN_IDENTIFIER_PREFIX);
    expect(userIdFromOnboardingIdentifier(hashOnboardingToken(token))).toBeNull();
  });
});

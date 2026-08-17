import { createHash, randomBytes } from 'node:crypto';

export const ONBOARDING_TOKEN_IDENTIFIER_PREFIX = 'onboard:';
export const ONBOARDING_TOKEN_TTL_DAYS = 14;
export const ONBOARDING_TOKEN_TTL_MS = ONBOARDING_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export function onboardingIdentifier(userId: string): string {
  return `${ONBOARDING_TOKEN_IDENTIFIER_PREFIX}${userId}`;
}

export function userIdFromOnboardingIdentifier(identifier: string): string | null {
  if (!identifier.startsWith(ONBOARDING_TOKEN_IDENTIFIER_PREFIX)) return null;
  const userId = identifier.slice(ONBOARDING_TOKEN_IDENTIFIER_PREFIX.length);
  return userId.length > 0 ? userId : null;
}

export function generateOnboardingToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOnboardingToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

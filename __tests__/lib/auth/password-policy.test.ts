import { describe, it, expect } from 'vitest';
import { passwordPolicyError, PASSWORD_RULE_TEXT } from '@/lib/auth/password-policy';

describe('règle unique du mot de passe', () => {
  it('refuse 7 caractères, accepte 8 et 72, refuse 73', () => {
    expect(passwordPolicyError('a'.repeat(7))).toMatch(/au moins 8/);
    expect(passwordPolicyError('a'.repeat(8))).toBeNull();
    expect(passwordPolicyError('a'.repeat(72))).toBeNull();
    expect(passwordPolicyError('a'.repeat(73))).toMatch(/au plus 72/);
  });
  it('le texte affiché dit la règle', () => {
    expect(PASSWORD_RULE_TEXT).toContain('8');
    expect(PASSWORD_RULE_TEXT).toContain('72');
  });
});

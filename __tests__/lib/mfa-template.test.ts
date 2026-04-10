// Smoke test pour le template d'email MFA — garantit qu'on produit bien un
// HTML qui contient le code + la durée, et que le sujet est correct.

import { describe, it, expect } from 'vitest';
import { renderMfaCodeEmail } from '@/lib/email/templates/mfa-code';

describe('renderMfaCodeEmail', () => {
  it('inclut le code et la durée d\'expiration', () => {
    const { subject, html, text } = renderMfaCodeEmail({
      code: '482910',
      expiresInMinutes: 10,
    });

    expect(subject).toBe('Code de connexion Veridian');
    expect(html).toContain('482910');
    expect(html).toContain('10 minutes');
    expect(text).toContain('482910');
    expect(text).toContain('10 minutes');
  });

  it('échappe correctement les caractères HTML du code', () => {
    // Improbable qu'un code numérique contienne <> mais on vérifie la sécu
    const { html } = renderMfaCodeEmail({
      code: '<script>',
      expiresInMinutes: 5,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

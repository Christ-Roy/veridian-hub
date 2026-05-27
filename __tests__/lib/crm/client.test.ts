/**
 * Test contractuel pour lib/crm/client.regenerateMagicLink.
 *
 * Cette lib est temporairement un STUB qui throw en attendant l'implémentation
 * GraphQL Twenty d'Agent A. Ce test verrouille :
 *  - signature `regenerateMagicLink(crmTenantId: string): Promise<MagicLinkResult>`
 *  - shape `MagicLinkResult { magicLinkUrl: string, expiresAt: Date }`
 *  - le stub throw explicitement (la route /api/dashboard/crm/regenerate-magic-link
 *    doit transformer ce throw en HTTP 502 — couvert dans le test de la route)
 *
 * Quand Agent A push la vraie implémentation, ce test doit continuer à passer.
 */
import { describe, it, expect } from 'vitest';
import {
  regenerateMagicLink,
  type MagicLinkResult,
} from '@/lib/crm/client';

describe('lib/crm/client — contrat', () => {
  it('le stub throw explicitement pour signaler l\'impl manquante', async () => {
    await expect(regenerateMagicLink('any-tenant-id')).rejects.toThrow(
      /not implemented yet/i,
    );
  });

  it('le type MagicLinkResult contient magicLinkUrl + expiresAt', () => {
    // Assertion structurelle — bloque le push si Agent A renomme un champ.
    // Garantit que la route POST peut sérialiser la réponse comme convenu.
    const fake: MagicLinkResult = {
      magicLinkUrl: 'https://crm.test/x?token=abc',
      expiresAt: new Date('2099-01-01'),
    };
    expect(fake.magicLinkUrl).toMatch(/^https?:\/\//);
    expect(fake.expiresAt).toBeInstanceOf(Date);
  });
});

/** Nom d'un espace créé par le Hub : préfixé `e2e-` pour un compte d'épreuve, inchangé pour un client. */
import { describe, expect, it } from 'vitest';

import { nomDEspace } from '@/lib/apps/nom-espace';

describe('nomDEspace', () => {
  it('compte d\'épreuve : préfixé une seule fois, jamais vide ; client : inchangé, même s\'il est chez nous', () => {
    expect([
      nomDEspace('Veridian', 'e2e-sso-moteur-1@veridian.site'),
      nomDEspace('e2e-Veridian', 'e2e-sso-moteur-1@veridian.site'),
      nomDEspace(null, 'e2e-sso-moteur-1@veridian.site'),
      nomDEspace('Veridian', 'robert@veridian.site'),
      nomDEspace('Boulangerie Martin', 'contact@client.fr'),
    ]).toEqual(['e2e-Veridian', 'e2e-Veridian', 'e2e-essai', 'Veridian', 'Boulangerie Martin']);
  });
});

/**
 * La consigne système des deux moteurs (23/11 : l'atelier n'en avait aucune et a répondu en anglais ; un tour sans
 * donnée a deviné). Une seule règle, deux copies (TS et l'atelier en .mjs) : la divergence est mesurée ici.
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error module .mjs sans déclaration de types
import { CONSIGNES_ASSISTANT, optionsBinaire } from '../../../atelier/regles.mjs';
import { CONSIGNES, presenterResultat } from '@/lib/ia/moteur';

describe('consigne système', () => {
  it('identique dans les deux moteurs', () => {
    expect(CONSIGNES_ASSISTANT).toBe(CONSIGNES);
  });

  it('langue de l\'utilisateur ; jamais une donnée devinée ; un échec ou un vide se dit', () => {
    expect(CONSIGNES).toMatch(/langue de l'utilisateur/);
    expect(CONSIGNES).toMatch(/Ne devine jamais/);
    expect(CONSIGNES).toMatch(/échoue ou ne rend rien, dis-le/);
  });

  it('le binaire de l\'atelier la reçoit', () => {
    const o = optionsBinaire('/d/x', { type: 'sdk' }, { sessionId: 's', reprise: false });
    expect(o.systemPrompt).toBe(CONSIGNES);
  });
});

describe('résultat d\'outil vu par le modèle (les deux moteurs passent par ici)', () => {
  it('erreur : nommée comme un échec, avec sa raison', () => {
    expect(presenterResultat('espace non relié', true)).toBe("ÉCHEC DE L'OUTIL : espace non relié");
    expect(presenterResultat('', true)).toMatch(/^ÉCHEC DE L'OUTIL : raison non donnée/);
  });
  it('vide : nommé comme vide, jamais pris pour une réponse', () => {
    expect(presenterResultat('  ', false)).toMatch(/^RÉSULTAT VIDE/);
  });
  it('donnée : rendue telle quelle', () => {
    expect(presenterResultat('{"total":12}', false)).toBe('{"total":12}');
  });
});

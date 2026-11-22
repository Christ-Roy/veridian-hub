/** Brancher son abonnement : l'échec dit sa vraie raison (23/11 : atelier en panne, Robert recliquait dans le vide). */
import { describe, expect, it } from 'vitest';

import { messageEchec } from '@/app/dashboard/ia/MonAbonnement';

describe('messageEchec', () => {
  it('panne de notre côté : le dit, et ne pousse pas à recliquer', () => {
    for (const code of ['atelier_injoignable', 'atelier_indisponible', 'hors_reseau_atelier', 'binaire_introuvable']) {
      const m = messageEchec(code, 'debut');
      expect(m, code).toContain('de notre côté');
      expect(m, code).not.toMatch(/réessayez dans un instant/i);
    }
  });

  it('compte non ouvert, code refusé, connexion expirée : chacun sa raison', () => {
    expect(messageEchec('abonnement_ferme', 'debut')).toContain("n'est pas ouvert");
    expect(messageEchec('connexion_refusee', 'code')).toContain('refusé ce code');
    expect(messageEchec('connexion_non_commencee', 'code')).toContain('expiré');
  });
});

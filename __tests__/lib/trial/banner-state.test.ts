/**
 * Tests de `resolveTrialBannerState` — agrégation des lignes `tenant_trials`
 * d'un user en une seule phase d'affichage du bandeau dashboard.
 *
 * Garantit la conformité à `docs/PRICING-VERIDIAN.md` §"Interdits côté code" :
 * aucun bandeau en phase silencieuse (`eligible` / absence de ligne), bandeau
 * uniquement à partir de la révélation du trial.
 *
 * Logique pure : aucun mock Prisma.
 */

import { describe, it, expect } from 'vitest';

import {
  resolveTrialBannerState,
  type TrialRowForBanner,
} from '@/lib/trial/banner-state';

const row = (state: TrialRowForBanner['state']): TrialRowForBanner => ({ state });

describe('resolveTrialBannerState — phases silencieuses (pas de bandeau)', () => {
  it('aucune ligne trial → null (user fraîchement inscrit, phases 1-3)', () => {
    expect(resolveTrialBannerState([], false)).toBeNull();
  });

  it('état eligible → null (phase 4 pas encore atteinte, J+2 invisible)', () => {
    expect(resolveTrialBannerState([row('eligible')], false)).toBeNull();
  });

  it('plusieurs apps toutes eligible → null', () => {
    expect(
      resolveTrialBannerState([row('eligible'), row('eligible')], false),
    ).toBeNull();
  });

  it('état converted → null (le user a déjà une subscription)', () => {
    expect(resolveTrialBannerState([row('converted')], false)).toBeNull();
  });

  it('hasActiveSubscription=true → null même si une ligne est trial_active', () => {
    // Garde-fou UX : un user qui paie ne voit jamais de bandeau trial.
    expect(resolveTrialBannerState([row('trial_active')], true)).toBeNull();
  });

  it('hasActiveSubscription=true → null même si une ligne est expired', () => {
    expect(resolveTrialBannerState([row('expired')], true)).toBeNull();
  });
});

describe('resolveTrialBannerState — phases visibles (bandeau)', () => {
  it('trial_active → phase active', () => {
    expect(resolveTrialBannerState([row('trial_active')], false)).toEqual({
      phase: 'active',
    });
  });

  it('trial_ending_soon → phase ending_soon', () => {
    expect(resolveTrialBannerState([row('trial_ending_soon')], false)).toEqual({
      phase: 'ending_soon',
    });
  });

  it('expired → phase expired', () => {
    expect(resolveTrialBannerState([row('expired')], false)).toEqual({
      phase: 'expired',
    });
  });
});

describe('resolveTrialBannerState — agrégation multi-apps par priorité', () => {
  it('trial_active + trial_ending_soon → ending_soon (le plus urgent)', () => {
    expect(
      resolveTrialBannerState(
        [row('trial_active'), row('trial_ending_soon')],
        false,
      ),
    ).toEqual({ phase: 'ending_soon' });
  });

  it('trial_ending_soon + expired → expired (le plus urgent)', () => {
    expect(
      resolveTrialBannerState([row('trial_ending_soon'), row('expired')], false),
    ).toEqual({ phase: 'expired' });
  });

  it('eligible + trial_active → active (eligible ignoré, ne masque pas)', () => {
    expect(
      resolveTrialBannerState([row('eligible'), row('trial_active')], false),
    ).toEqual({ phase: 'active' });
  });

  it('converted + expired → expired (converted ne prime pas sur expired)', () => {
    // converted a la priorité la plus basse : si une autre app est expired,
    // c'est expired qui remonte. Le garde-fou subscription gère le vrai
    // "user converti" en amont.
    expect(
      resolveTrialBannerState([row('converted'), row('expired')], false),
    ).toEqual({ phase: 'expired' });
  });

  it("l'ordre des lignes n'influe pas sur le résultat", () => {
    const a = resolveTrialBannerState(
      [row('expired'), row('trial_active')],
      false,
    );
    const b = resolveTrialBannerState(
      [row('trial_active'), row('expired')],
      false,
    );
    expect(a).toEqual(b);
    expect(a).toEqual({ phase: 'expired' });
  });
});

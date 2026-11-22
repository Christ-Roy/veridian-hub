/**
 * Catalogue Stripe local rempli au démarrage (scripts/init-stripe.mjs). Le 22/11, au staging, le prix de
 * « Veridian Pro » n'y était pas : la liste s'arrêtait aux 100 premiers prix (le compte de test porte les
 * boutiques des clients) et le filtre écartait les produits marqués seulement `veridian_plan`. Un
 * abonnement à ce prix était perdu en silence.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error module .mjs sans déclaration de types
import { estProduitVeridian, listerTout } from '../../scripts/lib/stripe-catalogue.mjs';

describe('estProduitVeridian', () => {
  it('retient namespace=veridian, un bundle marqué veridian_plan et l\'ancien produit de base', () => {
    expect(estProduitVeridian({ metadata: { namespace: 'veridian' } })).toBe(true);
    expect(estProduitVeridian({ metadata: { veridian_plan: 'veridian-pro', veridian_apps: 'notifuse,prospection' } })).toBe(true);
    expect(estProduitVeridian({ metadata: { productKey: 'BASE_PRODUCT' } })).toBe(true);
  });

  it('écarte les produits des boutiques clientes', () => {
    expect(estProduitVeridian({ metadata: { asd_slug: 'wildpet-performance', asd_prefixe: 'ZZ-TEST-ASD-' } })).toBe(false);
    expect(estProduitVeridian({ metadata: {} })).toBe(false);
  });
});

describe('listerTout', () => {
  it('lit toutes les pages, pas seulement les 100 premiers éléments', async () => {
    const page = (debut: number, n: number, plus: boolean) => ({
      data: Array.from({ length: n }, (_, i) => ({ id: `price_${debut + i}` })),
      has_more: plus,
    });
    const lister = vi
      .fn()
      .mockResolvedValueOnce(page(0, 100, true))
      .mockResolvedValueOnce(page(100, 100, true))
      .mockResolvedValueOnce(page(200, 7, false));
    const tout = await listerTout(lister, { expand: ['data.product'] });
    expect(tout).toHaveLength(207);
    expect(lister).toHaveBeenNthCalledWith(2, expect.objectContaining({ starting_after: 'price_99', expand: ['data.product'] }));
    expect(lister).toHaveBeenNthCalledWith(3, expect.objectContaining({ starting_after: 'price_199' }));
  });
});

describe('scripts/init-stripe.mjs', () => {
  const src = readFileSync(join(__dirname, '../../scripts/init-stripe.mjs'), 'utf8');

  it('passe par listerTout et estProduitVeridian, sans liste à une seule page', () => {
    expect(src).toMatch(/listerTout\(\(p\) => stripe\.products\.list\(p\)\)/);
    expect(src).toMatch(/listerTout\(\(p\) => stripe\.prices\.list\(p\)/);
    expect(src).not.toMatch(/stripe\.(products|prices)\.list\(\{ limit: 100/);
  });

  it('resynchronise à chaque démarrage : plus de « déjà synchronisé, on saute »', () => {
    expect(src).not.toMatch(/already synced - skipping/);
  });
});

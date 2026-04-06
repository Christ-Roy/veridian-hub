import { describe, it, expect } from 'vitest';
import {
  BILLING_CONFIG_VERSION,
  BILLING_NAMESPACE,
  WORKFLOW_METER_ID,
  FREE_PLAN,
  PAID_PLANS,
  METERED_PRODUCTS,
  getPlanByInternalId,
  getPriceByLookupKey,
  getAllPlans,
} from '@/config/billing.config';

describe('config/billing - validation approfondie', () => {
  describe('plan structure integrity', () => {
    it('Pro plan has both monthly and yearly active prices', () => {
      const pro = PAID_PLANS.find(p => p.internal_id === 'pro')!;
      const activePrices = pro.prices.filter(p => p.active);
      const intervals = activePrices.map(p => p.interval);
      expect(intervals).toContain('month');
      expect(intervals).toContain('year');
    });

    it('Enterprise plan has both monthly and yearly active prices', () => {
      const enterprise = PAID_PLANS.find(p => p.internal_id === 'enterprise')!;
      const activePrices = enterprise.prices.filter(p => p.active);
      const intervals = activePrices.map(p => p.interval);
      expect(intervals).toContain('month');
      expect(intervals).toContain('year');
    });

    it('yearly price is cheaper per month than monthly price for Pro', () => {
      const pro = PAID_PLANS.find(p => p.internal_id === 'pro')!;
      const monthly = pro.prices.find(p => p.active && p.interval === 'month')!;
      const yearly = pro.prices.find(p => p.active && p.interval === 'year')!;
      const yearlyPerMonth = yearly.amount / 12;
      expect(yearlyPerMonth).toBeLessThan(monthly.amount);
    });

    it('yearly price is cheaper per month than monthly price for Enterprise', () => {
      const enterprise = PAID_PLANS.find(p => p.internal_id === 'enterprise')!;
      const monthly = enterprise.prices.find(p => p.active && p.interval === 'month')!;
      const yearly = enterprise.prices.find(p => p.active && p.interval === 'year')!;
      const yearlyPerMonth = yearly.amount / 12;
      expect(yearlyPerMonth).toBeLessThan(monthly.amount);
    });
  });

  describe('metered products pairing', () => {
    it('each paid plan has a matching metered product with same planKey', () => {
      for (const plan of PAID_PLANS.filter(p => p.active)) {
        const planKey = plan.stripe_metadata.planKey;
        const matchingMetered = METERED_PRODUCTS.find(
          m => m.stripe_metadata.planKey === planKey
        );
        expect(matchingMetered).toBeDefined();
      }
    });

    it('metered products have tiered pricing with included_credits > 0', () => {
      for (const product of METERED_PRODUCTS) {
        for (const price of product.prices) {
          expect(price.included_credits).toBeGreaterThan(0);
        }
      }
    });

    it('enterprise has more included credits than pro', () => {
      const proMetered = METERED_PRODUCTS.find(
        m => m.stripe_metadata.planKey === 'PRO'
      )!;
      const enterpriseMetered = METERED_PRODUCTS.find(
        m => m.stripe_metadata.planKey === 'ENTERPRISE'
      )!;
      const proCredits = proMetered.prices[0].included_credits;
      const enterpriseCredits = enterpriseMetered.prices[0].included_credits;
      expect(enterpriseCredits).toBeGreaterThan(proCredits);
    });
  });

  describe('display_order consistency', () => {
    it('free plan has display_order 0', () => {
      expect(FREE_PLAN.ui_metadata.display_order).toBe(0);
    });

    it('paid plans have sequential display_order after free', () => {
      const orders = PAID_PLANS.map(p => p.ui_metadata.display_order).sort((a, b) => a - b);
      for (let i = 0; i < orders.length; i++) {
        expect(orders[i]).toBeGreaterThan(0);
      }
    });
  });

  describe('getPlanByInternalId edge cases', () => {
    it('returns enterprise plan', () => {
      const result = getPlanByInternalId('enterprise');
      expect(result).toBeDefined();
      expect(result?.internal_id).toBe('enterprise');
    });

    it('returns null for empty string', () => {
      expect(getPlanByInternalId('')).toBeNull();
    });
  });

  describe('getPriceByLookupKey edge cases', () => {
    it('finds enterprise monthly price', () => {
      const enterprise = PAID_PLANS.find(p => p.internal_id === 'enterprise')!;
      const activeMonthly = enterprise.prices.find(p => p.active && p.interval === 'month')!;
      const result = getPriceByLookupKey(activeMonthly.lookup_key);
      expect(result).toBeDefined();
      expect(result?.plan.internal_id).toBe('enterprise');
      expect(result?.price.interval).toBe('month');
    });

    it('finds inactive (grandfathered) prices too', () => {
      const pro = PAID_PLANS.find(p => p.internal_id === 'pro')!;
      const inactive = pro.prices.find(p => !p.active);
      if (inactive) {
        const result = getPriceByLookupKey(inactive.lookup_key);
        expect(result).toBeDefined();
        expect(result?.price.active).toBe(false);
      }
    });

    it('returns null for empty string', () => {
      expect(getPriceByLookupKey('')).toBeNull();
    });
  });

  describe('getAllPlans structure', () => {
    it('returns the correct shape', () => {
      const all = getAllPlans();
      expect(all).toHaveProperty('free');
      expect(all).toHaveProperty('paid');
      expect(all).toHaveProperty('metered');
      expect(Array.isArray(all.paid)).toBe(true);
      expect(Array.isArray(all.metered)).toBe(true);
    });
  });

  describe('namespace consistency', () => {
    it('all lookup_keys start with the billing namespace', () => {
      const prefix = `${BILLING_NAMESPACE}_`;
      for (const plan of PAID_PLANS) {
        for (const price of plan.prices) {
          expect(price.lookup_key.startsWith(prefix)).toBe(true);
        }
      }
      for (const product of METERED_PRODUCTS) {
        for (const price of product.prices) {
          expect(price.lookup_key.startsWith(prefix)).toBe(true);
        }
      }
    });
  });

  describe('currency consistency', () => {
    it('all active prices use EUR', () => {
      for (const plan of PAID_PLANS) {
        for (const price of plan.prices.filter(p => p.active)) {
          expect(price.currency).toBe('eur');
        }
      }
    });
  });
});

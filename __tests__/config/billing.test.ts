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
  validateBillingConfig,
  getAllPlans,
} from '@/config/billing.config';

describe('config/billing', () => {
  describe('constants', () => {
    it('has a billing config version matching semver', () => {
      expect(BILLING_CONFIG_VERSION).toBeDefined();
      expect(BILLING_CONFIG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('has namespace veridian', () => {
      expect(BILLING_NAMESPACE).toBe('veridian');
    });

    it('has a workflow meter ID starting with mtr_', () => {
      expect(WORKFLOW_METER_ID).toBeDefined();
      expect(WORKFLOW_METER_ID).toMatch(/^mtr_/);
    });
  });

  describe('FREE_PLAN', () => {
    it('has required fields', () => {
      expect(FREE_PLAN.internal_id).toBe('freemium');
      expect(FREE_PLAN.name).toBeDefined();
      expect(FREE_PLAN.trial_days).toBeGreaterThan(0);
      expect(FREE_PLAN.ui_metadata.features.length).toBeGreaterThan(0);
    });
  });

  describe('PAID_PLANS', () => {
    it('has at least 2 plans (Pro and Enterprise)', () => {
      expect(PAID_PLANS.length).toBeGreaterThanOrEqual(2);
    });

    it('each plan has required fields', () => {
      for (const plan of PAID_PLANS) {
        expect(plan.internal_id).toBeDefined();
        expect(plan.name).toBeDefined();
        expect(plan.description).toBeDefined();
        expect(plan.type).toBe('LICENSED');
        expect(plan.prices.length).toBeGreaterThan(0);
        expect(plan.stripe_metadata.planKey).toBeDefined();
        expect(plan.stripe_metadata.productKey).toBe('BASE_PRODUCT');
      }
    });

    it('each price has valid lookup_key with veridian prefix', () => {
      for (const plan of PAID_PLANS) {
        for (const price of plan.prices) {
          expect(price.lookup_key).toMatch(/^veridian_/);
          expect(['eur', 'usd']).toContain(price.currency);
          expect(['month', 'year']).toContain(price.interval);
          expect(price.amount).toBeGreaterThan(0);
        }
      }
    });

    it('active plans have at least one active price', () => {
      for (const plan of PAID_PLANS.filter(p => p.active)) {
        const activePrices = plan.prices.filter(p => p.active);
        expect(activePrices.length).toBeGreaterThan(0);
      }
    });
  });

  describe('METERED_PRODUCTS', () => {
    it('has metered products for workflow execution', () => {
      expect(METERED_PRODUCTS.length).toBeGreaterThan(0);
    });

    it('each metered product references the workflow meter', () => {
      for (const product of METERED_PRODUCTS) {
        expect(product.meter_id).toBe(WORKFLOW_METER_ID);
        expect(product.stripe_metadata.priceUsageBased).toBe('METERED');
        expect(product.stripe_metadata.productKey).toBe('WORKFLOW_NODE_EXECUTION');
      }
    });
  });

  describe('getPlanByInternalId', () => {
    it('returns free plan for freemium', () => {
      const result = getPlanByInternalId('freemium');
      expect(result).toBeDefined();
      expect(result?.internal_id).toBe('freemium');
    });

    it('returns pro plan', () => {
      const result = getPlanByInternalId('pro');
      expect(result).toBeDefined();
      expect(result?.internal_id).toBe('pro');
    });

    it('returns null for unknown plan', () => {
      const result = getPlanByInternalId('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getPriceByLookupKey', () => {
    it('returns plan and price for valid lookup key', () => {
      const result = getPriceByLookupKey('veridian_pro_monthly_v3');
      expect(result).toBeDefined();
      expect(result?.plan.internal_id).toBe('pro');
      expect(result?.price.lookup_key).toBe('veridian_pro_monthly_v3');
    });

    it('returns null for unknown lookup key', () => {
      const result = getPriceByLookupKey('nonexistent_key');
      expect(result).toBeNull();
    });
  });

  describe('getAllPlans', () => {
    it('returns free, paid, and metered plans', () => {
      const all = getAllPlans();
      expect(all.free).toBeDefined();
      expect(all.paid).toBeDefined();
      expect(all.metered).toBeDefined();
      expect(all.free.internal_id).toBe('freemium');
      expect(all.paid.length).toBeGreaterThan(0);
      expect(all.metered.length).toBeGreaterThan(0);
    });
  });

  describe('validateBillingConfig', () => {
    it('does not throw for current config', () => {
      expect(() => validateBillingConfig()).not.toThrow();
    });
  });

  describe('no duplicate lookup_keys across all plans', () => {
    it('all lookup keys are unique', () => {
      const allKeys: string[] = [];
      for (const plan of PAID_PLANS) {
        for (const price of plan.prices) {
          allKeys.push(price.lookup_key);
        }
      }
      for (const product of METERED_PRODUCTS) {
        for (const price of product.prices) {
          allKeys.push(price.lookup_key);
        }
      }
      const unique = [...new Set(allKeys)];
      expect(allKeys.length).toBe(unique.length);
    });
  });
});

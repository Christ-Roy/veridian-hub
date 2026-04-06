import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getURL,
  toDateTime,
  calculateTrialEndUnixTimestamp,
  getStatusRedirect,
  getErrorRedirect,
} from '@/utils/helpers';

describe('utils/helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getURL', () => {
    it('returns NEXT_PUBLIC_SITE_URL when set', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
      expect(getURL()).toBe('https://app.veridian.site');
    });

    it('defaults to localhost when no env vars set', () => {
      delete process.env.NEXT_PUBLIC_SITE_URL;
      delete process.env.NEXT_PUBLIC_VERCEL_URL;
      expect(getURL()).toBe('http://localhost:3000');
    });

    it('appends path correctly', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
      expect(getURL('dashboard')).toBe('https://app.veridian.site/dashboard');
    });

    it('strips leading slashes from path', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
      expect(getURL('/dashboard')).toBe('https://app.veridian.site/dashboard');
    });

    it('strips trailing slashes from URL', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site///';
      expect(getURL()).toBe('https://app.veridian.site');
    });

    it('adds https:// when missing', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'app.veridian.site';
      expect(getURL()).toBe('https://app.veridian.site');
    });

    it('keeps http:// for localhost', () => {
      delete process.env.NEXT_PUBLIC_SITE_URL;
      delete process.env.NEXT_PUBLIC_VERCEL_URL;
      const url = getURL();
      expect(url).toContain('http://localhost');
    });
  });

  describe('toDateTime', () => {
    it('converts seconds to Date', () => {
      const date = toDateTime(0);
      expect(date.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    });

    it('converts 86400 seconds to Jan 2', () => {
      const date = toDateTime(86400);
      expect(date.getUTCDate()).toBe(2);
      expect(date.getUTCMonth()).toBe(0); // January
    });
  });

  describe('calculateTrialEndUnixTimestamp', () => {
    it('returns undefined for trial less than 2 days', () => {
      expect(calculateTrialEndUnixTimestamp(1)).toBeUndefined();
      expect(calculateTrialEndUnixTimestamp(0)).toBeUndefined();
    });

    it('returns a future timestamp for valid trial days', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = calculateTrialEndUnixTimestamp(7);
      expect(result).toBeDefined();
      expect(result!).toBeGreaterThan(now);
      // Should be roughly 7 days in the future (within 10 seconds tolerance)
      const expectedEnd = now + 7 * 24 * 60 * 60;
      expect(Math.abs(result! - expectedEnd)).toBeLessThan(10);
    });

    it('uses default trial days when null', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = calculateTrialEndUnixTimestamp(null);
      expect(result).toBeDefined();
      // Default is 7 days
      const expectedEnd = now + 7 * 24 * 60 * 60;
      expect(Math.abs(result! - expectedEnd)).toBeLessThan(10);
    });

    it('uses default trial days when undefined', () => {
      const result = calculateTrialEndUnixTimestamp(undefined);
      expect(result).toBeDefined();
    });
  });

  describe('getStatusRedirect', () => {
    it('creates a redirect URL with status params', () => {
      const result = getStatusRedirect('/dashboard', 'Success', 'Account created');
      expect(result).toBe('/dashboard?status=Success&status_description=Account%20created');
    });

    it('handles status without description', () => {
      const result = getStatusRedirect('/dashboard', 'Success');
      expect(result).toBe('/dashboard?status=Success');
    });

    it('adds disable_button param', () => {
      const result = getStatusRedirect('/dashboard', 'Success', '', true);
      expect(result).toContain('disable_button=true');
    });

    it('adds arbitrary params', () => {
      const result = getStatusRedirect('/dashboard', 'Success', '', false, 'plan=pro');
      expect(result).toContain('plan=pro');
    });
  });

  describe('getErrorRedirect', () => {
    it('creates a redirect URL with error params', () => {
      const result = getErrorRedirect('/signin', 'Auth failed', 'Invalid credentials');
      expect(result).toBe('/signin?error=Auth%20failed&error_description=Invalid%20credentials');
    });

    it('handles error without description', () => {
      const result = getErrorRedirect('/signin', 'Auth failed');
      expect(result).toBe('/signin?error=Auth%20failed');
    });
  });
});

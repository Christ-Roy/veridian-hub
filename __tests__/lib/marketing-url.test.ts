import { describe, it, expect } from 'vitest';
import { resolveMarketingUrl, resolvePlateformeUrl } from '@/lib/marketing-url';

describe('resolvePlateformeUrl', () => {
  it('retourne https://veridian.site/plateforme par défaut', () => {
    expect(resolvePlateformeUrl({})).toBe('https://veridian.site/plateforme');
  });

  it('respecte VERIDIAN_SITE_URL (override base) + suffixe /plateforme', () => {
    expect(resolvePlateformeUrl({ VERIDIAN_SITE_URL: 'https://veridian.io' })).toBe(
      'https://veridian.io/plateforme',
    );
  });

  it('trim le slash final + ajoute https:// si scheme absent', () => {
    expect(resolvePlateformeUrl({ VERIDIAN_SITE_URL: 'veridian.site/' })).toBe(
      'https://veridian.site/plateforme',
    );
  });
});

describe('resolveMarketingUrl', () => {
  it('retourne le défaut https://veridian.site si MARKETING_URL absent', () => {
    expect(resolveMarketingUrl({})).toBe('https://veridian.site');
  });

  it('retourne le défaut si MARKETING_URL est une chaîne vide', () => {
    expect(resolveMarketingUrl({ MARKETING_URL: '' })).toBe('https://veridian.site');
    expect(resolveMarketingUrl({ MARKETING_URL: '   ' })).toBe('https://veridian.site');
  });

  it('utilise MARKETING_URL quand posée (ex page produit dédiée)', () => {
    expect(resolveMarketingUrl({ MARKETING_URL: 'https://veridian.site/plateforme' })).toBe(
      'https://veridian.site/plateforme',
    );
  });

  it('trim le slash final pour éviter les //', () => {
    expect(resolveMarketingUrl({ MARKETING_URL: 'https://veridian.site/' })).toBe(
      'https://veridian.site',
    );
    expect(resolveMarketingUrl({ MARKETING_URL: 'https://veridian.site/plateforme///' })).toBe(
      'https://veridian.site/plateforme',
    );
  });

  it('ajoute https:// si le scheme est absent', () => {
    expect(resolveMarketingUrl({ MARKETING_URL: 'veridian.site/plateforme' })).toBe(
      'https://veridian.site/plateforme',
    );
  });

  it('préserve un scheme http:// explicite (dev local)', () => {
    expect(resolveMarketingUrl({ MARKETING_URL: 'http://localhost:4321' })).toBe(
      'http://localhost:4321',
    );
  });
});

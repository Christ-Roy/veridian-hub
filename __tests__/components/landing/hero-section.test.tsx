/**
 * Test smoke pour HeroSection après removal Twenty (2026-05-18).
 *
 * Vérifie que le composant rend sans mentionner "Twenty".
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroSection } from '@/components/landing/hero-section';

describe('HeroSection', () => {
  it('renders without "Twenty" branding', () => {
    render(<HeroSection />);
    const body = document.body.textContent || '';
    expect(body.toLowerCase()).not.toContain('twenty');
  });

  it('shows the main CTA "Commencer gratuitement"', () => {
    render(<HeroSection />);
    expect(screen.getByText(/Commencer gratuitement/i)).toBeTruthy();
  });

  it('shows the new "Pilotez vos SaaS" headline', () => {
    render(<HeroSection />);
    expect(screen.getByText(/Pilotez vos SaaS/i)).toBeTruthy();
  });
});

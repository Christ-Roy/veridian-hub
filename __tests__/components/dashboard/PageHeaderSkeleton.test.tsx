/**
 * Tests PageHeaderSkeleton — squelette du DashboardPageHeader rendu pendant
 * les async fetches Server Component. Utilisé par tous les `loading.tsx` de
 * route segment du dashboard.
 *
 * 2026-05-24 — créé après commits `f6bdab4` + `0776aec` (8 loading.tsx
 * ajoutés). Verrouille la structure DOM minimale et la prop `withIcon`.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';

describe('PageHeaderSkeleton', () => {
  it('rend au moins 2 Skeleton (icône h-8 + titre + ligne description) par défaut', () => {
    const { container } = render(<PageHeaderSkeleton />);
    // Les Skeleton shadcn portent la classe `bg-accent` ou `animate-pulse`.
    // On compte les éléments avec cette signature visuelle.
    const skeletons = container.querySelectorAll('[class*="animate-pulse"], [class*="bg-accent"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('rend 2 Skeleton seulement quand withIcon={false} (pas d\'icône)', () => {
    const { container: withIcon } = render(<PageHeaderSkeleton withIcon />);
    const { container: withoutIcon } = render(<PageHeaderSkeleton withIcon={false} />);
    const skelWith = withIcon.querySelectorAll('[class*="animate-pulse"], [class*="bg-accent"]').length;
    const skelWithout = withoutIcon.querySelectorAll('[class*="animate-pulse"], [class*="bg-accent"]').length;
    expect(skelWith - skelWithout).toBe(1);
  });

  it('forwarde className sur le wrapper racine', () => {
    const { container } = render(<PageHeaderSkeleton className="my-custom-wrapper" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('my-custom-wrapper');
  });

  it('a une structure DOM stable : 1 wrapper > [flex row icône+titre, ligne description]', () => {
    const { container } = render(<PageHeaderSkeleton />);
    const root = container.firstChild as HTMLElement;
    // Premier enfant = flex row pour icône + titre
    expect(root.children.length).toBe(2);
    expect((root.children[0] as HTMLElement).className).toMatch(/flex/);
  });
});

/**
 * Tests GoogleTagManager — gating env-driven + a11y noscript iframe.
 *
 * Pas un test "le script GTM fonctionne" (impossible en JSDOM), mais un
 * test du COMPORTEMENT DU COMPOSANT :
 *   - sans `NEXT_PUBLIC_GTM_ID` → ne rend rien + log un error
 *   - avec `NEXT_PUBLIC_GTM_ID` → rend les 2 scripts attendus + le noscript
 *     iframe avec le bon ID
 *
 * Ces tests verrouillent la régression "on a accidentellement enlevé le
 * gating" qui pourrait shipper du GTM en dev / staging.
 *
 * 2026-05-24 — créé après commit `757363a` (suppression des 8 console.log
 * de debug). Verrouille que `console.error` legit reste, et que le composant
 * rend bien quand GTM_ID est posé.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GoogleTagManager, GoogleTagManagerNoScript } from '@/components/analytics/gtm';

// next/script rend une balise <script> en mode JSDOM
vi.mock('next/script', () => ({
  default: ({ id, children, dangerouslySetInnerHTML }: {
    id?: string;
    children?: React.ReactNode;
    dangerouslySetInnerHTML?: { __html: string };
  }) => (
    <script
      data-testid={`next-script-${id}`}
      dangerouslySetInnerHTML={dangerouslySetInnerHTML}
    >
      {children}
    </script>
  ),
}));

describe('GoogleTagManager', () => {
  const originalGtmId = process.env.NEXT_PUBLIC_GTM_ID;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalGtmId === undefined) {
      delete process.env.NEXT_PUBLIC_GTM_ID;
    } else {
      process.env.NEXT_PUBLIC_GTM_ID = originalGtmId;
    }
  });

  it('retourne null + log console.error quand NEXT_PUBLIC_GTM_ID est absent', () => {
    delete process.env.NEXT_PUBLIC_GTM_ID;
    const { container } = render(<GoogleTagManager />);
    expect(container.innerHTML).toBe('');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[GTM\] GTM_ID is missing/),
    );
  });

  it('retourne null + log console.error quand NEXT_PUBLIC_GTM_ID est vide string', () => {
    process.env.NEXT_PUBLIC_GTM_ID = '';
    const { container } = render(<GoogleTagManager />);
    expect(container.innerHTML).toBe('');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('rend le script GTM quand NEXT_PUBLIC_GTM_ID est posé', () => {
    process.env.NEXT_PUBLIC_GTM_ID = 'GTM-TESTID42';
    const { container } = render(<GoogleTagManager />);
    const scriptHtml = container.innerHTML;
    expect(scriptHtml).toContain('GTM-TESTID42');
    expect(scriptHtml).toMatch(/googletagmanager\.com\/gtm\.js/);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('GoogleTagManagerNoScript rend le fallback iframe avec le bon GTM ID (SSR)', () => {
    // JSDOM ne rend pas le contenu d'un <noscript> (spec navigateur quand JS
    // est activé). On utilise donc renderToStaticMarkup côté serveur pour
    // obtenir le HTML complet — c'est précisément ce qui sera servi en prod.
    process.env.NEXT_PUBLIC_GTM_ID = 'GTM-NS123';
    const html = renderToStaticMarkup(<GoogleTagManagerNoScript />);
    expect(html).toContain('<noscript>');
    expect(html).toContain('GTM-NS123');
    expect(html).toMatch(/googletagmanager\.com\/ns\.html/);
    expect(html).toContain('iframe');
  });

  it('GoogleTagManagerNoScript retourne null + console.error si GTM_ID manquant', () => {
    delete process.env.NEXT_PUBLIC_GTM_ID;
    const { container } = render(<GoogleTagManagerNoScript />);
    expect(container.innerHTML).toBe('');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[GTM NoScript\] GTM_ID is missing/),
    );
  });

  it('ne contient AUCUN console.log debug — seul console.error legit autorisé (anti-régression `757363a`)', () => {
    // Ce test surveille la régression "remettre des console.log de debug"
    // après le cleanup commit `757363a`. On mock console.log + console.warn
    // pour s'assurer qu'aucun n'est appelé pendant render.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NEXT_PUBLIC_GTM_ID = 'GTM-XYZ';
    render(<GoogleTagManager />);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

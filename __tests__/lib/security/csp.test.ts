/** CSP du Hub : jamais de script inline, report-uri seul, et un rapport ne garde ni query ni extrait de code. */
import { describe, expect, it } from 'vitest';

import { enteteCsp, nonce, politique, resumerRapport } from '@/lib/security/csp';

describe('politique', () => {
  it('scripts par nonce seulement, aucun plugin, report-uri sans report-to ; eval seulement en développement', () => {
    const p = politique('ABC', false);
    expect([p.includes("script-src 'self' 'nonce-ABC' 'strict-dynamic';"), p.includes("object-src 'none'"), p.includes('report-uri /api/csp'), /report-to|unsafe-inline'[^;]*;?\s*$/.test(p.split('; ').find((d) => d.startsWith('script-src'))!), p.includes('unsafe-eval')]).toEqual([true, true, true, false, false]);
    expect(politique('ABC', true)).toContain("'unsafe-eval'");
  });
});
describe('enteteCsp', () => {
  it('Report-Only par défaut, bloquant seulement sur CSP_MODE=appliquer', () => {
    expect([enteteCsp({}), enteteCsp({ CSP_MODE: 'rapport' }), enteteCsp({ CSP_MODE: 'appliquer' })]).toEqual(['Content-Security-Policy-Report-Only', 'Content-Security-Policy-Report-Only', 'Content-Security-Policy']);
  });
});
describe('nonce', () => {
  it('neuf à chaque appel, 16 octets en base64', () => {
    const a = nonce();
    expect([a === nonce(), Buffer.from(a, 'base64').length]).toEqual([false, 16]);
  });
});
describe('resumerRapport', () => {
  it('garde la directive et l\'origine, retire query et extrait ; ignore ce qui n\'est pas un rapport', () => {
    const r = resumerRapport({ 'csp-report': { 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://x.test/a.js?jeton=secret', 'document-uri': 'https://app.veridian.site/auth/reset?token=abc', 'script-sample': 'alert(1)', 'source-file': 'https://app.veridian.site/p.js?v=1', 'line-number': 3 } });
    expect(r).toEqual([{ directive: 'script-src-elem', bloque: 'https://x.test/a.js', page: 'https://app.veridian.site/auth/reset', source: 'https://app.veridian.site/p.js:3' }]);
    expect([JSON.stringify(r).includes('secret'), JSON.stringify(r).includes('alert'), resumerRapport({ rien: 1 }), resumerRapport([{ type: 'csp-violation', body: { effectiveDirective: 'script-src-attr', blockedURL: 'inline', documentURL: 'https://app.veridian.site/x' } }])[0].bloque]).toEqual([false, false, [], 'inline']);
  });
});

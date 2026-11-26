/**
 * CSP du Hub (VER-265) : chaque page qu'un client voit se charge sans aucune violation de la politique (Report-Only ou bloquante).
 * La console du navigateur dit chaque violation (« Content Security Policy ») ; une seule fait échouer le cas. Garde du passage en
 * mode bloquant : ce qui passe ici ne casse pas une fois la CSP appliquée.
 * Épreuve : `SSO_SABOTAGE=csp-injecte` injecte un onerror sur la première page : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas } from './lib/etat';
import { contexteDe } from './lib/monde';
import { creerCompteProuve } from './lib/parcours';

/** Les pages du Hub sans paramètre de chemin, hors administration de la plateforme et ateliers (relevées le 26/11 dans app/). */
const PAGES = [
  '/', '/login', '/signup', '/pricing', '/legal', '/privacy', '/terms', '/signin/forgot_password',
  '/auth/organisation', '/auth/preuve-requise', '/auth/bounce/error?code=user_not_in_app',
  '/dashboard', '/dashboard/billing', '/dashboard/connexions', '/dashboard/ia', '/dashboard/liaisons', '/dashboard/organisation',
  '/dashboard/settings', '/dashboard/settings/mail', '/dashboard/settings/security', '/dashboard/workspace/members',
];
/** Avertissement attendu d'une politique Report-Only, pas une violation. */
const BRUIT = /'upgrade-insecure-requests' is ignored when delivered in a report-only policy/;

cas('hub', 'CSP : chaque page du Hub vue par un client se charge sans aucune violation de la politique', async ({ browser }) => {
  const E = await creerCompteProuve(browser, 'csp');
  const ctx = await contexteDe(browser, E);
  // La fenêtre de l'assistant, telle qu'une app l'insère pour l'organisation du compte (VER-203).
  const pages = [...PAGES, ...(E.tenantId ? [`/ia/chat?app=notifuse&tenant=${E.tenantId}`] : [])];
  const violations: string[] = [];
  let entetes = 0;
  try {
    for (const [i, chemin] of pages.entries()) {
      const page = await ctx.newPage();
      page.on('console', (m) => {
        const t = m.text();
        if (/Content Security Policy/i.test(t) && !BRUIT.test(t)) violations.push(`${chemin} : ${t.slice(0, 180)}`);
      });
      const r = await page.goto(`${HUB_URL}${chemin}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => null);
      const h = r?.headers() ?? {};
      if (h['content-security-policy-report-only']?.includes("'nonce-") || h['content-security-policy']?.includes("'nonce-")) entetes += 1;
      if (i === 0 && process.env.SSO_SABOTAGE === 'csp-injecte') {
        await page.evaluate(() => { const d = document.createElement('div'); d.innerHTML = '<img src="/x-csp-epreuve.png" onerror="window.__x=1">'; document.body.appendChild(d); });
      }
      await page.waitForTimeout(2_000);
      await page.close();
    }
  } finally {
    await ctx.close();
  }
  expect(entetes, 'chaque page porte la CSP à nonce').toBe(pages.length);
  expect(violations, `${violations.length} violation(s)`).toEqual([]);
  return `${pages.length} pages (fenêtre de l'assistant comprise), CSP à nonce sur chacune, 0 violation dans la console`;
});

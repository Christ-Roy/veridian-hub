/**
 * Ce qu'une personne voit au Hub (25/11) : Prospection s'ouvre par le rebond signé (VER-106), rien de promis à qui n'a pas de site (VER-105), l'IA se relie
 * sans clé (VER-203), les liaisons se disent « actives par défaut » (VER-245), et un lien d'activation expiré se renouvelle seul (VER-104).
 * Captures : e2e/systeme-sso/.run/captures/. NON PROUVÉ : le mail du nouveau lien, lu dans une vraie boîte (il part à une adresse d'épreuve).
 * Épreuves : `SSO_SABOTAGE=tableau-session` retire la session avant d'ouvrir Prospection ; `tableau-lien` pose un lien encore bon : le cas doit échouer.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup, usersCreate } from './lib/hub-admin';
import { adresseDe, creerCompteProuve, noter, noterEspaceTwenty, sessionApp, type Compte } from './lib/parcours';
import { RUN_DIR } from './lib/versions';

const CAPTURES = join(RUN_DIR, 'captures');
const capture = async (page: Page, nom: string) => {
  mkdirSync(CAPTURES, { recursive: true });
  await page.screenshot({ path: join(CAPTURES, `${nom}.png`), fullPage: true });
};

/** Une personne entre par le menu : la page doit y avoir un lien. Déjà sur la page : on la relit. */
const parLeMenu = async (page: Page, nom: string, chemin: string) => {
  if (new URL(page.url()).pathname === chemin) await page.reload({ waitUntil: 'networkidle' });
  else {
    await page.getByRole('link', { name: nom, exact: true }).first().click();
    await page.waitForURL((u) => u.pathname === chemin);
    await page.waitForLoadState('networkidle');
  }
};

cas(null, 'tableau de bord : Prospection par le rebond, l\'IA sans clé, liaisons actives par défaut, lien expiré renouvelé', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (Prospection absente de staging)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const P: Compte = await creerCompteProuve(browser, 'tableau');
  const ctx = await browser.newContext({ storageState: P.etat as never, viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(45_000);
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    await capture(page, 'tableau-de-bord');
    expect(await page.locator('body').innerText(), 'sans site : rien de promis').not.toContain('Inclus avec votre site');
    const lien = page.getByRole('link', { name: /Ouvrir Prospection/ });
    expect(await lien.getAttribute('href'), 'le rebond, jamais un jeton').toBe(`/login?next=${encodeURIComponent(`${APP_URL.prospection}/`)}`);
    expect((await ctx.request.post(`${HUB_URL}/api/prospection/regenerate-login`)).status(), 'l\'ancienne porte n\'existe plus').toBe(404);

    // L'IA sans clé : un compte sans CRM n'en voit aucune.
    await parLeMenu(page, 'Assistants IA', '/dashboard/ia');
    await capture(page, 'ia-sans-crm');
    await expect(page.getByRole('link', { name: 'Ajouter à Claude' })).toBeVisible();
    for (const a of ['Mail', 'Prospection|Atlas']) await expect(page.getByRole('list', { name: 'Apps ouvertes à votre IA' }).getByText(new RegExp(a))).toBeVisible();
    expect(await page.locator('input[type=password]').count(), 'aucune clé proposée').toBe(0);

    // Avec le CRM : la clé existe, repliée ; le CRM rejoint les apps de l'IA sans un clic ; et les liaisons se disent actives.
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string } | undefined;
    if (!T) throw new NonAbouti('compte de test sans tenant');
    noterEspaceTwenty(P.email, T.id);
    await parLeMenu(page, 'Assistants IA', '/dashboard/ia');
    await capture(page, 'ia-avec-crm');
    await expect(page.getByRole('list', { name: 'Apps ouvertes à votre IA' }).getByText('CRM')).toBeVisible();
    expect(await page.locator('#ia-cle').isVisible(), 'la clé est repliée').toBe(false);
    await page.goto(`${HUB_URL}/dashboard/connexions`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Voir', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/dashboard/liaisons');
    await page.waitForLoadState('networkidle');
    await capture(page, 'liaisons');
    await expect(page.getByText('Active par défaut').first()).toBeVisible();

    // Prospection s'ouvre, connectée, depuis le bouton.
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    if (sabotage === 'tableau-session') await ctx.clearCookies();
    const [onglet] = await Promise.all([ctx.waitForEvent('page'), lien.click()]);
    await onglet.waitForURL((u) => u.origin === new URL(APP_URL.prospection).origin, { timeout: 45_000 }).catch(() => {});
    await onglet.waitForLoadState('networkidle').catch(() => {});
    const s = (await sessionApp(ctx, 'prospection')) as { email?: string } | null;
    expect(s?.email?.toLowerCase(), `session Prospection, arrivé sur ${new URL(onglet.url()).host}`).toBe(P.email.toLowerCase());
  } finally {
    await ctx.close();
  }

  // Lien d'activation : expiré, il se redemande ; encore bon, il ne se remplace pas.
  const email = adresseDe('lienexpire');
  noter(email);
  await usersCreate(email, 'TEST SYSTEME SSO lienexpire');
  const inviter = (validiteMinutes?: number) => adminOk<{ invite_url: string; user_id: string }>('POST', 'onboarding/invite', { email, apps: ['hub'], invitedBy: 'TEST SYSTEME SSO', sendEmail: false, validiteMinutes });
  const jeton = (u: string) => u.split('/').pop() as string;
  const neuf = await inviter();
  const neutre = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    expect((await neutre.request.post(`${HUB_URL}/api/onboarding/${jeton(neuf.invite_url)}/renouveler`)).status(), 'un lien encore bon').toBe(409);
    const vieux = await inviter(sabotage === 'tableau-lien' ? undefined : 1);
    const page = await neutre.newPage();
    await page.waitForTimeout(65_000);
    await page.goto(vieux.invite_url, { waitUntil: 'networkidle' });
    await capture(page, 'lien-expire');
    expect(await page.locator('body').innerText(), 'l\'adresse n\'est pas dite').not.toContain(email);
    await page.getByRole('button', { name: 'Demander un nouveau lien' }).click({ timeout: 15_000 });
    await expect(page.getByRole('status')).toContainText('envoyé');
    await capture(page, 'lien-renouvele');
    expect((await neutre.request.post(`${HUB_URL}/api/onboarding/${jeton(vieux.invite_url)}/renouveler`)).status(), 'l\'ancien lien ne renvoie plus rien').toBe(404);
    const journal = await admin<{ entries?: { target_id?: string; targetId?: string }[]; logs?: { targetId?: string }[] }>('GET', `audit-log?action=onboarding.lien_renouvele&limit=20`);
    expect(JSON.stringify(journal.json), 'le renvoi est au journal').toContain(vieux.user_id);
  } finally {
    await neutre.close();
  }
});

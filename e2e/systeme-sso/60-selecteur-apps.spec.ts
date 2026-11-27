/**
 * Sélecteur d'apps de l'en-tête (27/11) : un client passe d'une app à l'autre sans repasser par le tableau de bord. Sur ce qui est servi, avec un
 * compte jetable prouvé : le bouton est là, il déplie le Hub puis les apps OUVERTES de ce compte (CRM, Mail, Prospection), Academy absente sans
 * activation ; chaque lien d'app passe par le rebond signé du Hub (`/login?next=`), jamais un jeton ; suivre celui du CRM mène DANS le CRM,
 * connecté, sans page de refus. Captures bureau et 375 px dans `.run/captures`.
 * Épreuve : `SSO_SABOTAGE=selecteur-academy` exige Academy dans le menu : le cas doit échouer.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { creerCompteProuve } from './lib/parcours';
import { RUN_DIR } from './lib/versions';

cas(null, 'sélecteur d\'apps : les apps ouvertes, par le rebond, et le CRM atteint d\'un clic', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (Mail et Prospection provisionnés)');
  const A = await creerCompteProuve(browser, 'selecteur');
  const captures = join(RUN_DIR, 'captures');
  mkdirSync(captures, { recursive: true });
  const ctx = await browser.newContext({ storageState: A.etat as never });
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    const bouton = page.getByRole('button', { name: 'Changer d\'application Veridian' });
    await bouton.waitFor({ timeout: 30_000 });
    await bouton.click();
    const menu = page.getByRole('navigation', { name: 'Applications Veridian' });
    await menu.waitFor();
    await page.screenshot({ path: join(captures, 'selecteur-apps-bureau.png') });
    const liens = await menu.getByRole('link').evaluateAll((as) => as.map((a) => ({ texte: (a.textContent ?? '').trim(), href: a.getAttribute('href') ?? '' })));
    const noms = liens.map((l) => l.texte);
    const voulues = ['Hub Veridian', 'CRM', 'Mail', 'Prospection', ...(process.env.SSO_SABOTAGE === 'selecteur-academy' ? ['Academy'] : [])];
    expect(voulues.filter((n) => !noms.some((t) => t.includes(n))), `menu lu : ${JSON.stringify(noms)}`).toEqual([]);
    expect(noms.filter((t) => t.includes('Academy')), 'Academy sans activation').toEqual([]);
    const apps = liens.filter((l) => /CRM|Mail|Prospection/.test(l.texte));
    expect(apps.filter((l) => !l.href.startsWith('/login?next=') || /jeton|token|secret/i.test(l.href)).map((l) => l.texte), 'rebond signé, jamais un jeton').toEqual([]);

    // Le même menu à 375 px : il tient dans l'écran.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.keyboard.press('Escape');
    await bouton.click();
    const boite = await menu.boundingBox();
    await page.screenshot({ path: join(captures, 'selecteur-apps-375.png') });
    expect(boite && boite.x >= 0 && boite.x + boite.width <= 375, `menu à 375 px : ${JSON.stringify(boite)}`).toBe(true);

    // Suivre le lien du CRM : on arrive DANS le CRM, sans page de refus du rebond.
    const crm = apps.find((l) => l.texte.includes('CRM'))!;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(new URL(crm.href, HUB_URL).href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForURL((u) => !u.href.startsWith(HUB_URL), { timeout: 90_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
    const arrivee = new URL(page.url());
    await page.screenshot({ path: join(captures, 'selecteur-apps-crm.png') });
    // Le CRM sert chaque espace sur son sous-domaine (`<espace>.crm.app.veridian.site`).
    expect([/(^|\.)crm\.app\.veridian\.site$/.test(arrivee.host), /bounce\/error|\/login|\/welcome/.test(arrivee.pathname)], `arrivée : ${arrivee.host}${arrivee.pathname}`).toEqual([true, false]);
    return `menu [${noms.join(', ')}] ; liens par le rebond ; 375 px tenu ; CRM atteint (${arrivee.host}${arrivee.pathname.slice(0, 40)})`;
  } finally {
    await ctx.close();
  }
}, { timeout: 600_000 });

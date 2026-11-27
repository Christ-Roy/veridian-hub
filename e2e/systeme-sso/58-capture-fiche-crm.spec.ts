/**
 * Capture d'une fiche du CRM, vue par le propriétaire d'une organisation d'essai (VER-267, 27/11) : la preuve « la fiche et ses lignes existent »
 * se montre à l'écran, sans geste de Robert ni lien d'entrée dans le chat. Compte : la fiche d'essai du cas 49 (~/credentials/essai-crm-prod.json,
 * 600), connexion au Hub par son mot de passe, entrée au CRM par le rebond. La personne se retrouve par son adresse (`SSO_FICHE_EMAIL`), lue dans
 * le CRM avec la session de la page ; la fiche est capturée en entier dans `.run/captures/fiche-crm.png`.
 * Lecture seule : rien n'est écrit, ni au Hub ni au CRM. Sans fiche d'essai ou sans adresse visée : NON ABOUTI, jamais un échec.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { attendreSessionHub, connexionHub, ouvrirApp } from './lib/parcours';

type Json = any;

cas(null, 'capture d\'une fiche du CRM vue par le propriétaire de l\'organisation d\'essai (lecture seule)', async ({ browser }) => {
  const visee = (process.env.SSO_FICHE_EMAIL ?? '').trim().toLowerCase();
  const chemin = join(homedir(), 'credentials', 'essai-crm-prod.json');
  if (!visee.includes('@')) throw new NonAbouti('SSO_FICHE_EMAIL absent : quelle personne capturer ?');
  if (!existsSync(chemin)) throw new NonAbouti('aucune organisation d\'essai tenue (cas 49) : pas de fiche ~/credentials/essai-crm-prod.json');
  const f = JSON.parse(readFileSync(chemin, 'utf8')) as { hub: string; email: string; mot_de_passe: string; espace_crm: string };
  if (f.hub !== HUB_URL) throw new NonAbouti(`la fiche d'essai vise ${f.hub}, la batterie ${HUB_URL}`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await connexionHub(page, f.email, f.mot_de_passe);
    if (!(await attendreSessionHub(ctx, f.email))) throw new NonAbouti('connexion au Hub du propriétaire d\'essai : pas de session');
    const crm = new URL((await ouvrirApp(ctx, 'twenty')).url).origin;

    // La personne, lue avec la session du CRM ouverte par le rebond (comme le front).
    const query = '{people(first:50){edges{node{id name{firstName lastName} emails{primaryEmail}}}}}';
    let gens: { id: string; name?: { firstName?: string; lastName?: string }; emails?: { primaryEmail?: string } }[] = [];
    for (let i = 0; i < 10 && !gens.length; i++) {
      const r = await ctx.request.post(`${crm}/graphql`, { headers: { origin: crm, 'x-twenty-session-cookie': '1' }, data: { query }, timeout: 20_000 }).catch(() => null);
      gens = (((await r?.json().catch(() => null)) as Json)?.data?.people?.edges ?? []).map((e: { node: never }) => e.node);
      if (!gens.length) await new Promise((ok) => setTimeout(ok, 3_000));
    }
    const p = gens.find((g) => g.emails?.primaryEmail?.toLowerCase() === visee);
    if (!p) throw new NonAbouti(`aucune fiche à cette adresse dans l'espace (${gens.length} personne(s) lue(s))`);

    await page.goto(`${crm}/object/person/${p.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(p.name?.lastName || p.name?.firstName || visee).first(), 'la fiche est affichée').toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(4_000); // le fil des activités se charge après la fiche
    await page.screenshot({ path: '.run/captures/fiche-crm.png', fullPage: true });
    return `fiche ${p.id} (${[p.name?.firstName, p.name?.lastName].filter(Boolean).join(' ')}) capturée dans ${crm.replace(/^https:\/\//, '')} : .run/captures/fiche-crm.png`;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}, { timeout: 300_000 });

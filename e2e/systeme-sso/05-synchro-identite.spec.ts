/**
 * Le Hub est la seule source de vérité des utilisateurs (CONTRAT-HUB §3.8) : un nom et un
 * email changés au Hub se relisent dans chaque app, sur le compte de test, par la route que
 * `hub reconcile` utilise. L'adresse et le nom d'origine sont rétablis, puis relus.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from '@playwright/test';

import { APP_URL, type AppKey } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { identite } from './lib/hub-admin';
import { assurerRybbit, compte, contexteDe, ouvrirApp } from './lib/monde';
import { noter } from './lib/parcours';

const SECRET_DE: Partial<Record<AppKey, string>> = {
  prospection: 'PROSPECTION_TENANT_API_SECRET',
  notifuse: 'NOTIFUSE_HUB_API_SECRET',
  analytics: 'ANALYTICS_HUB_API_SECRET',
};

function secret(app: AppKey): string {
  const nom = SECRET_DE[app] as string;
  if (process.env[nom]) return process.env[nom] as string;
  const fichier = path.join(os.homedir(), 'credentials', '.all-creds.env');
  const ligne = readFileSync(fichier, 'utf8').split('\n').find((l) => l.startsWith(`${nom}=`));
  if (!ligne) throw new NonAbouti(`secret ${nom} introuvable`);
  return ligne.slice(nom.length + 1).trim().replace(/^['"]|['"]$/g, '');
}

type Local = { hub_user_id: string | null; email: string; name: string | null };

async function comptesDe(app: AppKey): Promise<Local[]> {
  const ts = String(Date.now());
  const sig = createHmac('sha256', secret(app)).update(`${ts}.`).digest('hex');
  let res: Response;
  try {
    res = await fetch(`${APP_URL[app]}/api/hub/users`, {
      headers: { 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': sig },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new NonAbouti(`${app} injoignable : ${(e as Error).message}`);
  }
  const texte = await res.text();
  if (!res.ok) throw new Error(`${app} : GET /api/hub/users répond ${res.status}, route du §3.8 absente`);
  let corps: { users?: Local[] } | null = null;
  try {
    corps = JSON.parse(texte);
  } catch {
    /* traité juste en dessous */
  }
  if (!Array.isArray(corps?.users)) {
    throw new Error(`${app} : GET /api/hub/users ne renvoie pas { users: [] } (${texte.length} octets)`);
  }
  return corps.users;
}

async function attendreCopie(app: AppKey, hubUserId: string, attendu: Partial<Local>, ms = 30_000) {
  const fin = Date.now() + ms;
  let lu: Local | undefined;
  do {
    lu = (await comptesDe(app)).find((u) => u.hub_user_id === hubUserId);
    if (lu && Object.entries(attendu).every(([k, v]) => lu?.[k as keyof Local] === v)) return lu;
    await new Promise((r) => setTimeout(r, 2_000));
  } while (Date.now() < fin);
  return lu;
}

for (const app of ['prospection', 'notifuse', 'analytics'] as const) {
  cas(
    app,
    'le nom et l\'email changés au Hub se relisent dans l\'app',
    async ({ browser }) => {
      const A = await compte(browser, 'A');
      if (app === 'analytics') assurerRybbit(A);
      const ctx = await contexteDe(browser, A);
      try {
        await ouvrirApp(ctx, app); // l'app n'a le compte qu'après ce passage
      } finally {
        await ctx.close();
      }

      const depart = await identite(A.email, { name: `TEST SYSTEME SSO ${app} ${Date.now()}` });
      const hubUserId = depart.hub_user_id;
      const avant = (await comptesDe(app)).find((u) => u.hub_user_id === hubUserId);
      if (!avant) throw new Error(`${app} : le compte de test n'est pas relié à son hub_user_id`);

      const nom = `TEST SYSTEME SSO renomme ${Date.now()}`;
      const nouvelEmail = A.email.replace('@', `-${app}@`);
      noter(nouvelEmail); // noté AVANT le changement : le nettoyage doit le retrouver
      const emailOrigine = avant.email;
      try {
        const poussee = await identite(A.email, { new_email: nouvelEmail, name: nom });
        expect(poussee.push[app], `${app} : résultat du push au Hub`).toBe('ok');
        const lu = await attendreCopie(app, hubUserId, { email: nouvelEmail, name: nom });
        expect(lu?.email, `${app} : email relu dans l'app`).toBe(nouvelEmail);
        expect(lu?.name, `${app} : nom relu dans l'app`).toBe(nom);
      } finally {
        await identite(nouvelEmail, { new_email: emailOrigine }).catch(() => undefined);
      }
      const retour = await attendreCopie(app, hubUserId, { email: emailOrigine });
      expect(retour?.email, `${app} : email rétabli`).toBe(emailOrigine);
      return `nom et email relus dans ${app}, adresse rétablie`;
    },
    { timeout: 240_000 },
  );
}

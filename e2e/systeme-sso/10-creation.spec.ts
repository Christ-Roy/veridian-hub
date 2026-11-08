/**
 * Création de compte par le chemin réel de Robert (Google, Microsoft) et pendant un déploiement.
 *
 * OAuth : le consentement chez Google ou Microsoft demande un humain (anti-robot, double facteur).
 * On mesure en prod ce qui se mesure : le Hub envoie chez le fournisseur avec SON adresse de retour,
 * et le fournisseur l'accepte (pas de `redirect_uri_mismatch` ; chez Microsoft, adresse d'un compte
 * personnel saisie, sans mot de passe : ni AADSTS ni `unauthorized_client`). La suite, création
 * du compte au retour, est NON ABOUTIE ici et prouvée au niveau contrat :
 * `__tests__/lib/auth/sign-in-callback.test.ts` (scénarios A, B), `create-user-event.test.ts`
 * (hub_user_id posé au premier retour OAuth), `__tests__/api/auth/dual-provider.test.ts`.
 * Épreuve : `SSO_SABOTAGE=oauth-retour` présente une adresse de retour fausse, le cas doit échouer.
 *
 * Déploiement : `SSO_PENDANT_DEPLOIEMENT=1 bash scripts/test-systeme-sso.sh 10-` juste après un
 * push du Hub. Le cas attend qu'un déploiement tourne, inscrit un compte et ouvre une app pendant
 * qu'il tourne, et sonde `/api/health` chaque seconde : aucune réponse en erreur admise.
 */
import { execFileSync } from 'node:child_process';

import { expect } from '@playwright/test';

import { devraitEtreArrive } from './lib/assertions';
import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { compte, contexteDe, ouvrirApp } from './lib/monde';

const FOURNISSEURS = [
  { id: 'google', hote: 'accounts.google.com', refus: /redirect_uri_mismatch|invalid_client|Erreur 400/i },
  { id: 'microsoft-entra-id', hote: 'login.microsoftonline.com', refus: /AADSTS\d+|unauthorized_client|unable to complete your request/i },
] as const;

/**
 * Microsoft (`/common`) ne juge le client et l'adresse de retour qu'une fois le compte saisi : on saisit
 * l'adresse d'un compte personnel réel, sans mot de passe (08/11 : `unauthorized_client … not enabled for
 * consumers` pour le compte de Robert, l'application Entra n'acceptant que les comptes professionnels).
 */
const SONDE_MICROSOFT = process.env.SSO_SONDE_MICROSOFT || 'robert.brunon@veridian.site';

for (const f of FOURNISSEURS) {
  cas(null, `OAuth ${f.id} : le Hub envoie chez le fournisseur avec son adresse de retour, acceptée`, async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const { csrfToken } = (await (await ctx.request.get(`${HUB_URL}/api/auth/csrf`)).json()) as { csrfToken: string };
      const r = await ctx.request.post(`${HUB_URL}/api/auth/signin/${f.id}`, {
        form: { csrfToken, callbackUrl: `${HUB_URL}/dashboard` },
        maxRedirects: 0,
      });
      const loc = r.headers()['location'];
      if (!loc) throw new Error(`${f.id} : le Hub ne redirige pas (HTTP ${r.status()})`);
      const vers = new URL(loc);
      expect(vers.host, `${f.id} : fournisseur`).toBe(f.hote);
      const retour = `${HUB_URL}/api/auth/callback/${f.id}`;
      expect(vers.searchParams.get('redirect_uri'), `${f.id} : adresse de retour`).toBe(retour);
      if (process.env.SSO_SABOTAGE === 'oauth-retour') {
        vers.searchParams.set('redirect_uri', `${HUB_URL}/api/auth/callback/sabotage`);
      }
      const page = await ctx.newPage();
      const rep = await page.goto(vers.toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      if (f.id === 'microsoft-entra-id') {
        const champ = page.locator('input[type=email]');
        if (!(await champ.count())) throw new NonAbouti('Microsoft : pas de champ d\'adresse, page inattendue');
        await champ.fill(SONDE_MICROSOFT);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
      }
      const texte = await page.locator('body').innerText().catch(() => '');
      const final = new URL(page.url());
      expect(f.refus.test(texte) || final.searchParams.get('error') !== null, `${f.id} refuse : « ${texte.slice(0, 160).replace(/\s+/g, ' ')} »`).toBe(false);
      expect(rep?.status() ?? 0, `${f.id} : page de connexion du fournisseur`).toBeLessThan(400);
      return `${f.hote} accepte ${retour}`;
    } finally {
      await ctx.close();
    }
  });
}

cas(null, 'OAuth Google et Microsoft : compte créé au retour du fournisseur', async () => {
  throw new NonAbouti(
    'consentement Google/Microsoft non automatisable en prod (humain, double facteur). Envoi chez le fournisseur mesuré ci-dessus ; ' +
      'création au retour prouvée au niveau contrat : sign-in-callback.test.ts (A, B), create-user-event.test.ts, dual-provider.test.ts',
  );
});

function deploiementHub(): string | null {
  try {
    return execFileSync('nomad', ['job', 'deployments', '-t', '{{range .}}{{.Status}}{{"\\n"}}{{end}}', 'hub'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).split('\n')[0] || null;
  } catch {
    return null;
  }
}

cas(null, 'inscription et ouverture d\'une app pendant un déploiement du Hub', async ({ browser }) => {
  if (process.env.SSO_PENDANT_DEPLOIEMENT !== '1') {
    throw new NonAbouti('se joue pendant un déploiement : SSO_PENDANT_DEPLOIEMENT=1 bash scripts/test-systeme-sso.sh 10- juste après un push du Hub');
  }
  const fin = Date.now() + 20 * 60_000;
  while (deploiementHub() !== 'running') {
    if (Date.now() > fin) throw new NonAbouti('aucun déploiement du Hub en cours en 20 min (ou Nomad illisible)');
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const versions = new Set<string>();
  const erreurs: string[] = [];
  let sonde = true;
  const sondage = (async () => {
    while (sonde) {
      const r = await fetch(`${HUB_URL}/api/health`, { signal: AbortSignal.timeout(5_000) }).catch((e) => e as Error);
      if (r instanceof Error) erreurs.push(`réseau ${r.message}`);
      else if (!r.ok) erreurs.push(`HTTP ${r.status}`);
      else versions.add(String(((await r.json().catch(() => ({}))) as { version?: string }).version ?? '?').slice(0, 7));
      await new Promise((x) => setTimeout(x, 1_000));
    }
  })();
  try {
    const G = await compte(browser, 'G');
    const pendant = deploiementHub();
    const ctx = await contexteDe(browser, G);
    try {
      devraitEtreArrive(await ouvrirApp(ctx, 'prospection'), 'prospection');
    } finally {
      await ctx.close();
    }
    sonde = false;
    await sondage;
    expect(erreurs, `santé du Hub pendant le déploiement : ${erreurs.slice(0, 5).join(', ')}`).toEqual([]);
    if (pendant !== 'running' && versions.size < 2) {
      throw new NonAbouti(`le déploiement a fini avant la fin de l'inscription (${pendant}), une seule version vue`);
    }
    return `compte ${G.email} créé et Prospection ouverte pendant le déploiement, versions vues ${Array.from(versions).join(' → ')}, 0 erreur`;
  } finally {
    sonde = false;
    await sondage;
  }
}, { timeout: 30 * 60_000 });

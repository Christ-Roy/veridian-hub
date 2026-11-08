/**
 * Un compte à adresse prouvée arrive dans l'app, à son nom, et voit ses données.
 * Parcours réel : invitation → mot de passe → session Hub → « ouvrir l'app ».
 */
import { expect } from '@playwright/test';

import { devraitEtreArrive } from './lib/assertions';
import { APP_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { noterEspaceTwenty } from './lib/parcours';
import { compte, contexteDe, noterArrivee, ouvrirApp , assurerRybbit } from './lib/monde';

const T = 'un compte à adresse prouvée arrive à son nom et voit ses données';

cas('prospection', T, async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'prospection');
  let ok = false;
  try {
    devraitEtreArrive(a, 'prospection');
    // à son nom : la session de l'app porte l'e-mail ET l'identifiant Hub du compte
    const s = await (await ctx.request.get(`${APP_URL.prospection}/api/auth/session`)).json();
    expect(s?.user?.email?.toLowerCase(), 'session Prospection : e-mail').toBe(A.email.toLowerCase());
    expect(s?.user?.id, 'session Prospection : identifiant = identifiant Hub').toBe(A.hubUserId);
    // ses données : son tenant et son espace de travail existent
    const me = await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json();
    expect(me?.tenantId, 'Prospection : tenant du compte').toBeTruthy();
    expect(me?.workspaces?.length, 'Prospection : au moins un espace de travail').toBeGreaterThan(0);
    const trial = await (await ctx.request.get(`${APP_URL.prospection}/api/trial`)).json();
    expect(trial?.plan, 'Prospection : plan lisible').toBeTruthy();
    ok = true;
    return `session ${A.email}, tenant ${me.tenantId}, plan ${trial.plan}`;
  } finally {
    noterArrivee('prospection', ok, a);
    await ctx.close();
  }
});

cas('notifuse', T, async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'notifuse');
  let ok = false;
  try {
    devraitEtreArrive(a, 'notifuse');
    expect(a.texte, 'Notifuse : la console annonce l\'e-mail du compte').toContain(A.email);
    const slug = A.email.replace(/^e2e-sso-/, '').split('@')[0];
    // ses données : son workspace (slug dérivé de l'identité) est dans le sélecteur
    expect(a.texte.replace(/[^a-z0-9]/gi, '').toLowerCase(), 'Notifuse : son workspace est listé').toContain(
      slug.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12),
    );
    ok = true;
    return `console ouverte pour ${A.email}`;
  } finally {
    noterArrivee('notifuse', ok, a);
    await ctx.close();
  }
});

cas('analytics', T, async ({ browser }) => {
  const A = await compte(browser, 'A');
  assurerRybbit(A);
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'analytics');
  let ok = false;
  try {
    devraitEtreArrive(a, 'analytics');
    // Rybbit : l'écran d'arrivée ne doit pas être une page de connexion
    expect(a.texte, 'Rybbit : pas de page de connexion').not.toMatch(/sign in|log in|connexion|se connecter/i);
    ok = true;
    return `arrivée sur ${a.chemin}`;
  } finally {
    noterArrivee('analytics', ok, a);
    await ctx.close();
  }
});

cas('twenty', T, async ({ browser }) => {
  const r = await fetch(`${APP_URL.twenty}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r || r.status >= 400) {
    throw new NonAbouti(
      `Twenty non servi (${APP_URL.twenty}/healthz → ${r ? 'HTTP ' + r.status : 'injoignable'}) : cas non joué`,
    );
  }
  const A = await compte(browser, 'A');
  if (!A.tenantId) throw new NonAbouti('compte de test sans tenant Hub');
  noterEspaceTwenty(A.email, A.tenantId); // noté AVANT la création : un plantage ne doit rien laisser
  // Le geste réel : aucune activation admin, la première ouverture crée l'espace (rebond du Hub).
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'twenty');
  let ok = false;
  try {
    // Twenty sert chaque espace sur son sous-domaine : l'arrivée se juge sur le domaine de l'app.
    const hoteApp = new URL(APP_URL.twenty).host;
    expect(a.hote === hoteApp || a.hote.endsWith(`.${hoteApp}`), `Twenty : arrivée sur ${a.hote}${a.chemin}`).toBe(true);
    expect(a.formulaireMotDePasse, 'Twenty : aucun mot de passe redemandé').toBe(false);
    const page = await ctx.newPage();
    await page.goto(a.url, { waitUntil: 'domcontentloaded' });
    const lu = await page.evaluate(async () => {
      const res = await fetch('/metadata', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-twenty-session-cookie': '1' },
        body: JSON.stringify({ query: '{currentUser{email} currentWorkspace{id}}' }),
      });
      return (await res.json().catch(() => null)) as {
        data?: { currentUser?: { email?: string }; currentWorkspace?: { id?: string } };
      } | null;
    });
    // Une écriture à son nom, relue : l'espace n'est pas qu'une vitrine.
    const nom = `Systeme SSO ${Date.now()}`;
    const ecrit = await page.evaluate(async (n) => {
      const gql = async (query: string, variables: object) =>
        (await (
          await fetch('/graphql', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-twenty-session-cookie': '1' },
            body: JSON.stringify({ query, variables }),
          })
        ).json().catch(() => null)) as any;
      const cree = await gql('mutation($d:CompanyCreateInput!){createCompany(data:$d){id name}}', { d: { name: n } });
      const id = cree?.data?.createCompany?.id;
      const lu = id ? await gql('query($i:UUID!){company(filter:{id:{eq:$i}}){name}}', { i: id }) : null;
      return { id, relu: lu?.data?.company?.name ?? null, erreur: cree?.errors?.[0]?.message ?? null };
    }, nom);
    await page.close();
    expect(ecrit.relu, `Twenty : société créée puis relue (${ecrit.erreur ?? ''})`).toBe(nom);
    expect(lu?.data?.currentUser?.email?.toLowerCase(), 'Twenty : session au nom du compte').toBe(A.email.toLowerCase());
    const espace = lu?.data?.currentWorkspace?.id;
    expect(espace, 'Twenty : un espace créé à la première ouverture').toBeTruthy();
    ok = true;
    return `espace ${espace} créé à la première ouverture, session ${A.email} sur ${a.hote}, société ${ecrit.id} écrite et relue`;
  } finally {
    noterArrivee('twenty', ok, a);
    await ctx.close();
  }
});

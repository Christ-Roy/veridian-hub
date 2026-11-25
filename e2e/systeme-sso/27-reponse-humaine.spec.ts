/**
 * F3 (VER-245) : une réponse humaine reçue dans Mail crée une tâche au CRM, une seule fois, et plus rien quand la liaison est coupée. Staging :
 * l'organisation est marquée de test, les espaces naissent pour ce cas. Mail est joué par l'épreuve, avec le secret que Mail rend au Hub.
 * `SSO_OUTIL_MAIL=<notifuse-veridian>/scripts/e2e/reponse-recue-staging.py` joue en plus la vraie émission de Mail.
 * `SSO_GARDER_MAIL=1` garde l'espace Mail, pour une vraie émission par la session Notifuse.
 * Épreuve : `SSO_SABOTAGE=reponse-humaine` ne confirme pas la liaison : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup, marquerTest, secretServiStaging } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';

const PAIRE = 'notifuse>crm';

cas(null, 'une réponse humaine reçue dans Mail devient une tâche au CRM, une fois, et plus rien une fois coupée', async ({ browser }) => {
  if (!/staging/.test(HUB_URL)) throw new NonAbouti('F3 n\'est joué par l\'épreuve qu\'en staging');
  const MAIL = /staging/.test(APP_URL.notifuse) ? APP_URL.notifuse : 'https://notifuse.staging.veridian.site';
  const mail = secretServiStaging('NOTIFUSE_HUB_API_SECRET');
  const versMail = async (methode: string, chemin: string, corps?: object) => {
    const body = corps ? JSON.stringify(corps) : '';
    const ts = String(Date.now());
    const r = await fetch(`${MAIL}${chemin}`, { method: methode, headers: { 'content-type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', mail).update(`${ts}.${body}`).digest('hex') }, body: body || undefined, signal: AbortSignal.timeout(60_000) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const poses: string[] = [];
  const inscrire = async (app_key: string, label: string, mcp_url: string) => {
    if ((await adminOk<{ apps: { appKey: string }[] }>('GET', 'mcp-apps')).apps.some((a) => a.appKey === app_key)) return;
    await adminOk('POST', 'mcp-apps', { app_key, label, mcp_url, acces: 'tous', enabled: true });
    poses.push(app_key);
  };
  const slug = `e2erep${Date.now().toString(36)}`;
  let cree = false;
  try {
    const P: Compte = await creerCompteProuve(browser, 'repprop');
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0];
    if (!T) throw new NonAbouti('compte de test sans tenant');
    noterEspaceTwenty(P.email, T.id);
    await marquerTest(T.id);
    const crm = (enabled: boolean) => adminOk('POST', 'mcp-apps', { app_key: 'twenty', label: 'CRM', mcp_url: 'https://crm.staging.veridian.site/mcp', acces: 'tous', enabled });
    await inscrire('twenty', 'CRM', 'https://crm.staging.veridian.site/mcp');
    const prov = await versMail('POST', '/api/tenants/provision', { tenant_id: slug, owner_email: P.email, workspace_name: 'TEST réponse', plan: 'free', email_proven: true, metadata: { hub_user_id: P.hubUserId } });
    if (prov.status >= 300) throw new NonAbouti(`espace Mail de staging : HTTP ${prov.status} ${JSON.stringify(prov.json).slice(0, 200)}`);
    cree = true;
    const lien = await versMail('POST', '/api/tenants/update-plan', { tenant_id: slug, plan: 'free', hub_tenant_id: T.id });
    if (lien.status >= 300) throw new NonAbouti(`lien de l'espace Mail : HTTP ${lien.status}`);

    // Le propriétaire, dans un vrai navigateur : allumer, confirmer ; couper ; rallumer.
    const regler = async (bouton: 'Allumer' | 'Couper', confirmer = false) => {
      const ctx = await browser.newContext({ storageState: P.etat as never });
      ctx.setDefaultTimeout(45_000);
      try {
        const page = await ctx.newPage();
        await page.goto(`${HUB_URL}/dashboard/liaisons`, { waitUntil: 'networkidle' });
        const formulaire = page.locator('form', { has: page.locator(`input[value="${PAIRE}"]`) });
        expect(await formulaire.count(), `liaison proposée : ${(await page.locator('main').innerText().catch(() => page.url())).slice(0, 400)}`).toBe(1);
        await formulaire.getByRole('button', { name: bouton }).click();
        if (!confirmer) return void (await expect(page.getByRole('status')).toContainText(bouton === 'Couper' ? 'coupée' : 'allumée'));
        await page.waitForURL(/\/liaisons\/confirmer\//);
        if (process.env.SSO_SABOTAGE === 'reponse-humaine') return;
        await page.getByRole('button', { name: 'Allumer' }).click();
        await expect(page.getByText('Liaison allumée')).toBeVisible();
      } finally {
        await ctx.close();
      }
    };
    await regler('Allumer', true);

    // Mail rend au Hub (signé) le secret de l'abonnement ; le rejouer rend le même.
    const abo = await versMail('POST', '/api/hub/evenements/abonnement', { hub_tenant_id: T.id, actif: true });
    if (abo.status !== 200 || !abo.json?.secret) throw new NonAbouti(`abonnement Mail : HTTP ${abo.status}`);
    expect(abo.json.url, 'Mail livre à CE Hub').toBe(`${HUB_URL}/api/evenements/notifuse`);
    const cle = Buffer.from(String(abo.json.secret).replace('whsec_', ''), 'base64');
    const n = Date.now().toString(36);
    const recevoir = async (id: string, data: object = {}, c: Buffer = cle) => {
      const corps = JSON.stringify({ id, type: 'message.received', workspace_id: abo.json.workspace_id, timestamp: new Date().toISOString(), data: { message_id: `m-${id}`, rfc_message_id: `${id}@e2e.invalid`, kind: 'reply_human', match_type: 'message_id', direction: 'in', email: `contact@reponse${n}.invalid`, thread_id: `t_${n}`, event_timestamp: new Date().toISOString(), ...data } });
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await fetch(`${HUB_URL}/api/evenements/notifuse`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${createHmac('sha256', c).update(`${id}.${ts}.${corps}`).digest('base64')}` }, body: corps, signal: AbortSignal.timeout(60_000) });
      return [r.status, (await r.json().catch(() => null)) as any] as const;
    };
    /** Comme Mail : un 5xx se réessaie, même identifiant. Le staging dort, son réveil en rend. */
    const livrer = async (id: string, data: object = {}) => {
      let r = await recevoir(id, data);
      for (let i = 0; i < 8 && r[0] >= 500; i++) {
        await new Promise((ok) => setTimeout(ok, 15_000));
        r = await recevoir(id, data);
      }
      return r;
    };
    const jeton = await obtenirJetonMcp(browser, P, 'TEST F3');
    const compter = async (quoi: 'tasks' | 'people') => {
      const t = (await outil(jeton, 'executer_outil', { nom: `twenty.find_many_${quoi}`, arguments: { limit: 100, select: ['id', ...(quoi === 'tasks' ? ['title'] : ['emails'])] }, espace: T.slug })).texte.replace(/\\"/g, '"');
      if (!/"success":\s*true|"records"|"count"|"result"/.test(t)) throw new NonAbouti(`lecture CRM ${quoi} : ${t.slice(0, 200)}`);
      return { n: new Set(t.match(/"id":\s*"[0-9a-f-]{36}"/g) ?? []).size, t };
    };
    const avant = await compter('tasks');
    expect((await recevoir(randomUUID(), {}, Buffer.alloc(32, 7)))[0], 'mauvais secret').toBe(401);
    expect((await recevoir(randomUUID(), { kind: 'reply_auto' }))[1]?.effet, 'réponse automatique').toBe('aucun');

    const id = randomUUID();
    const premiere = await livrer(id);
    expect(premiere, JSON.stringify(premiere)).toEqual([200, expect.objectContaining({ ok: true })]);
    // Réveil du staging : la première livraison peut avoir rendu 503 en_cours puis fini seule, le réessai lit alors deja_traite.
    expect(['cree', 'rejoue', 'aucun'], JSON.stringify(premiere[1])).toContain(premiere[1].effet);
    if (premiere[1].effet === 'aucun') expect(premiere[1].raison).toBe('deja_traite');
    const apres = await compter('tasks');
    expect(apres.n - avant.n, `une tâche de plus : ${apres.t.slice(0, 300)}`).toBe(1);
    expect((await compter('people')).t, 'la personne est au CRM').toContain(`contact@reponse${n}.invalid`);

    const meme = await livrer(id);
    expect([meme[0], meme[1].raison], 'même livraison').toEqual([200, 'deja_traite']);
    const suite = await livrer(randomUUID());
    expect([suite[0], suite[1].effet], `suite du même fil : ${JSON.stringify(suite[1])}`).toEqual([200, 'aucun']);
    expect((await compter('tasks')).n, 'toujours une seule tâche').toBe(apres.n);

    // Un vrai refus du CRM, dit en 200 (success:false, thread_invalide) : jamais pris pour un succès, la source réessaiera.
    const refuse = await recevoir(randomUUID(), { thread_id: 'fil/1', email: `refus@reponse${n}.invalid` });
    expect(refuse, 'refus du CRM en texte').toEqual([502, { error: 'crm_unreachable' }]);
    expect((await compter('tasks')).n, 'refusée : rien au CRM').toBe(apres.n);

    // CRM éteint au registre du Hub : 5xx, la source réessaie, rien n'est perdu.
    const perdu = randomUUID();
    const autreFil = { thread_id: `t2_${n}`, email: `autre@reponse${n}.invalid` };
    await crm(false);
    try {
      expect((await recevoir(perdu, autreFil))[0], 'CRM fermé : la source réessaiera').toBe(502);
    } finally {
      await crm(true);
    }
    const rattrape = await livrer(perdu, autreFil);
    expect([rattrape[0], ['cree', 'rejoue'].includes(rattrape[1].effet) || rattrape[1].raison === 'deja_traite'], `rattrapée : ${JSON.stringify(rattrape[1])}`).toEqual([200, true]);
    expect((await compter('tasks')).n, 'rattrapée : une seule tâche de plus').toBe(apres.n + 1);

    // Coupée : reçue, acquittée, sans effet. Rallumée : directe, et elle revit.
    await regler('Couper');
    const coupee = await recevoir(randomUUID(), { thread_id: `t3_${n}`, email: `c@reponse${n}.invalid` });
    expect([coupee[0], coupee[1].raison], 'coupée').toEqual([200, 'paire_eteinte']);
    expect((await compter('tasks')).n, 'coupée : rien au CRM').toBe(apres.n + 1);
    await regler('Allumer');
    const revit = await livrer(randomUUID(), { thread_id: `t4_${n}`, email: `d@reponse${n}.invalid` });
    // Rallumer recrée l'abonnement chez Mail, donc un secret neuf : l'ancien ne vaut plus rien.
    expect(revit[0], 'ancien secret après rallumage').toBe(401);

    // La vraie émission de Mail (déclencheur, livreur, signature, HTTP, réessais), jouée par son outil : rien n'est signé par l'épreuve. Seule la
    // lecture IMAP ne l'est pas. Le contact connu du CRM retrouve sa fiche, l'inconnu en reçoit une.
    const outilMail = process.env.SSO_OUTIL_MAIL;
    let vraie = 'vraie émission non jouée (SSO_OUTIL_MAIL absent)';
    if (outilMail) {
      const personnes = (await compter('people')).n;
      const emettre = (email: string, ...x: string[]) => {
        try {
          return { code: 0, sortie: execFileSync('python3', ['-I', outilMail, abo.json.workspace_id, '--email', email, '--attendre', '240', ...x], { encoding: 'utf8', timeout: 270_000 }) };
        } catch (e) {
          const x2 = e as { status?: number; stdout?: string };
          return { code: x2.status ?? 2, sortie: `${x2.stdout ?? ''}` };
        }
      };
      for (const email of [`contact@reponse${n}.invalid`, `neuf@reponse${n}.invalid`]) {
        const e = emettre(email);
        if (e.code === 2) throw new NonAbouti(`vraie émission : ${e.sortie.slice(-300)}`);
        expect(e.code, `vraie émission ${email.split('@')[0]} : ${e.sortie.slice(-400)}`).toBe(0);
      }
      const ignoree = emettre(`auto@reponse${n}.invalid`, '--kind', 'reply_auto');
      expect(ignoree.code, `réponse automatique acquittée : ${ignoree.sortie.slice(-300)}`).toBe(0);
      // La tâche peut finir juste après l'acquittement : le Hub répond avant 8 s et termine seul.
      await expect.poll(async () => (await compter('tasks')).n, { timeout: 90_000, message: 'deux tâches de plus' }).toBe(apres.n + 3);
      const p2 = await compter('people');
      expect([p2.n - personnes, p2.t.includes(`neuf@reponse${n}.invalid`), p2.t.includes(`auto@reponse${n}.invalid`)], 'une personne de plus, l\'inconnue').toEqual([1, true, false]);
      vraie = 'vraie émission de Mail livrée (contact connu, inconnu), réponse automatique sans effet';
    }
    return `espace ${slug}${process.env.SSO_GARDER_MAIL === '1' ? ` (gardé, tenant ${T.id})` : ''} : une tâche, une personne, rejeu et suite du fil sans rien de plus, CRM fermé 502 puis rattrapée, coupée sans effet, ancien secret refusé, ${vraie}`;
  } finally {
    for (const k of poses) await admin('DELETE', `mcp-apps?app_key=${k}`);
    if (cree && process.env.SSO_GARDER_MAIL !== '1') {
      const d = await versMail('DELETE', `/api/tenants/${slug}`);
      if (d.status >= 300 && d.status !== 404) console.error(`espace Mail ${slug} non retiré : HTTP ${d.status}`);
    }
  }
}, { timeout: 1_500_000 });

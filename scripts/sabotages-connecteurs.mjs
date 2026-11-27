#!/usr/bin/env node
/**
 * Chaque garde des connexions extérieures (VER-119), retirée une à une : les tests doivent le voir. À jouer par `lourd node scripts/sabotages-connecteurs.mjs [filtre]`.
 * Il modifie l'arbre le temps d'un sabotage et le remet. Sortie : 0 tous vus · 1 un sabotage passe inaperçu · 2 non abouti (motif introuvable, tests rouges sans sabotage).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const C = 'lib/connecteurs/';
const M = 'lib/mcp/';
const API = 'app/api/connecteurs/';
/** [nom, [fichier, motif, remplacement]…] */
const SABOTAGES = [
  ['a : un outil d\'écriture servi sans interrupteur', [C + 'outils.ts', "if (relu.acces === 'ecriture' && !ecriture) continue;", '']],
  ['a : un outil d\'écriture joué sans interrupteur', [C + 'porte.ts', "if (relu.acces === 'ecriture' && !ecriture) throw", 'if (false) throw']],
  ['a : l\'annonce du service crue', [C + 'outils.ts', 'annotations: { readOnlyHint: lit, destructiveHint: !lit, openWorldHint: true }', 'annotations: o.annotations']],
  ['a : un outil non relu joué', [C + 'porte.ts', "if (!relu) throw new AppInjoignable(`${name} n'est", "if (!relu) return marquer(this.c, (await this.s.appeler(name, args)) as never); if (!relu) throw new AppInjoignable(`${name} n'est"]],
  ['a : prototype pris pour un outil', [C + 'registre.ts', 'Object.hasOwn(c.outils, nom) ? c.outils[nom] : null', 'c.outils[nom] ?? null']],
  ['a : l\'écriture s\'hérite d\'un compte à l\'autre', [C + 'coffre.ts', "etat: 'active', ecriture: false, creeLe", "etat: 'active', creeLe"]],
  ['a : écriture allumée pour toutes les connexions', [C + 'coffre.ts', "where: { hubUserId, connecteur: c.cle, ...(ecriture", "where: { hubUserId, ...(ecriture"]],
  ['b : description changée encore servie', [C + 'outils.ts', 'relu.empreinte !== empreinte || ', '']],
  ['b : changée après avoir été listée, encore jouée', [C + 'porte.ts', 'if (!(await this.outils()).some((o) => o.name === name)) throw', 'if (false) throw']],
  ['b : définition relue à moitié', [C + 'outils.ts', 't.length <= DEFINITION_MAX_CAR ? t :', 't.length >= 0 ? t.slice(0, DEFINITION_MAX_CAR) :']],
  ['b : invisibles cachés à qui relit', [C + 'outils.ts', 'const t = montrer(JSON.stringify(o));', 'const t = JSON.stringify(o);']],
  ['c : un service lent retient la porte', [M + 'catalogue.ts', '(app.externe ? lireExterne : lireOutils)', '(lireOutils)']],
  ['c : une lecture par demande', [M + 'catalogue.ts', 'enVol.get(k) ?? lireOutils', 'lireOutils']],
  ['c : service lent redemandé aussitôt', [M + 'catalogue.ts', 'cacheEchecs.set(k, { a: now, raison });', '']],
  ['b : l\'empreinte oublie un champ', [C + 'outils.ts', 'JSON.stringify(stable(o))', 'JSON.stringify(stable({ name: o.name, description: o.description, inputSchema: o.inputSchema }))']],
  ['b : deux outils du même nom', [C + 'outils.ts', ' || l.filter((x) => x.name === o.name).length > 1', '']],
  ['b : résultat rendu nu', [C + 'porte.ts', 'return marquer(this.c, (await this.s.appeler(name, args)) as never);', 'return await this.s.appeler(name, args);']],
  ['b : erreur du service rendue nue', [C + 'porte.ts', "if (err instanceof AppErreurMcp) return marquer(this.c, { content: [{ type: 'text', text: String(err.message) }], isError: true });", 'if (err instanceof AppErreurMcp) throw err;']],
  ['b : raison d\'injoignable dite par le réseau', [C + 'porte.ts', 'if (err instanceof AppErreurMcp || err instanceof AppReseau || !(err instanceof AppInjoignable)) return', 'if (!(err instanceof AppInjoignable)) return']],
  ['b : la borne s\'imite', [C + 'texte.ts', ".replace(/contenu-externe/gi, 'contenu externe')", '']],
  ['b : la borne se devine', [C + 'texte.ts', "randomBytes(6).toString('hex')", "'abcdefabcdef'"]],
  ['b : invisibles gardés', [C + 'texte.ts', "s.replace(INVISIBLES, '')", 's']],
  ['b : la coupe mange la fermeture', [C + 'texte.ts', 'const MARGE = 600;', 'const MARGE = -90_000;']],
  ['b : l\'origine n\'est pas dite', [M + 'porte.ts', 'o.externe ? { origine:', 'false ? { origine:']],
  ['c : n\'importe quel hôte', [C + 'sortie.ts', "if (!hotes.includes(u.host)) throw", 'if (false) throw']],
  ['c : identifiants dans l\'adresse', [C + 'sortie.ts', ' || u.username || u.password', '']],
  ['c : hôtes annoncés non comparés', [C + 'oauth.ts', 'if (adresse !== undefined) tenirAdresse', 'if (false) tenirAdresse']],
  ['c : redirection suivie', [C + 'sortie.ts', "if (res.status >= 300 && res.status < 400) throw new SortieRefusee('redirection');", ''], [C + 'sortie.ts', "redirect: 'manual'", "redirect: 'follow'"]],
  ['c : taille libre', [C + 'sortie.ts', 'if (taille > b.max) {', 'if (false) {']],
  ['c : durée libre', [C + 'sortie.ts', 'o.signal ? AbortSignal.any([o.signal, delai]) : delai', 'o.signal ?? AbortSignal.timeout(30_000)']],
  ['c : le jeton part ailleurs sur l\'hôte', [C + 'sortie.ts', "if (url !== c.mcpUrl) throw new SortieRefusee('hote_inattendu');", '']],
  ['c : adresse privée jointe', [C + 'sortie.ts', '(d.fetchImpl ?? fetchGarde)(u.href', '(d.fetchImpl ?? (fetch as never as typeof fetchGarde))(u.href']],
  ['c : couper ou renouveler inscrit un client', [C + 'oauth.ts', "  const conf = await notreClient(db, c, retour, d);\n  if (!conf) throw new Error('non_inscrit');", '  const conf = await notreClientOuInscription(db, c, retour, d);']],
  ['d : connexion IA sans services', [C + 'porte.ts', '|| qui.services !== true || !servicesPermis(qui, await espaces())', '|| !servicesPermis(qui, await espaces())'], [C + 'porte.ts', 'qui.services === true && e.vivants', 'e.vivants']],
  ['d : session ouverte sans services', [C + 'porte.ts', 'if (!c || qui.services !== true) throw', 'if (!c) throw']],
  ['d : compte retiré', [C + 'porte.ts', 'e.vivants.length > 0 && ', '']],
  ['d : compte suspendu', [C + 'porte.ts', " && !e.suspendus.some((x) => x.role === 'proprietaire')", '']],
  ['d : joué par un programme', [M + 'porte.ts', 'if (o?.externe) return', 'if (false) return']],
  ['d : toute connexion IA a les services', [M + 'oauth.ts', 'services: t.services === true', 'services: true']],
  ['d : le renouvellement donne les services', [M + 'oauth.ts', 'services: c.services === true', 'services: true']],
  ['d : consentement sans l\'écran', ['app/api/oauth/authorize/route.ts', "connecteursOuverts() && p.services === '1'", 'connecteursOuverts()']],
  ['d : consentement fermé', ['app/api/oauth/authorize/route.ts', "connecteursOuverts() && p.services === '1'", "p.services === '1'"]],
  ['d : retour par la session d\'organisation', [API + 'retour/route.ts', '?.user?.federe === true', '?.user?.federe === 3 as never']],
  ['d : gestes par la session d\'organisation', [API + 'route.ts', ' || session.user.federe === true', '']],
  ['d : page lue par la session d\'organisation', ['app/dashboard/connexions/page.tsx', ' && session?.user?.federe !== true', '']],
  ['d : journal d\'une organisation', [M + 'porte.ts', 'app?.externe ? undefined : tenantId', 'false ? undefined : tenantId']],
  ['d : un service prend le nom d\'une de nos apps', [M + 'catalogue.ts', 'services.filter((s) => !siennes.some((a) => a.appKey === s.appKey))', 'services']],
  ['e : remplacé en silence', [C + 'coffre.ts', 'data: { attenteChiffre: scellerAttente(j), attenteCompte: j.compte } });', "data: { ...sceller(j), compte: j.compte, etat: 'active' } });"]],
  ['e : l\'ancien compte reste vivant', [C + 'coffre.ts', 'const revoquee = aRevoquer ? aRevoquer.length === 0 ||', 'const revoquee = aRevoquer ? true ||']],
  ['e : une attente oubliée vivante', [C + 'coffre.ts', 'const revoquee = c && avant ?', 'const revoquee = false && c && avant ?']],
  ['e : jeton neuf non gardé, laissé chez le service', [C + 'coffre.ts', 'const revoquee = c ? await revoquer(db, c, tousLes(j), retour, d) : false;\n    console.error(JSON.stringify({ tag: \'[connecteur]\', level: \'error\', msg: \'jeton neuf non gardé\'', 'const revoquee = false && c;\n    console.error(JSON.stringify({ tag: \'[connecteur]\', level: \'error\', msg: \'jeton neuf non gardé\'']],
  ['e : remplacer alors que c\'est fermé', [API + 'route.ts', "  if (!connecteursOuverts()) return vers('ferme');\n", "  if (geste === 'brancher' && !connecteursOuverts()) return vers('ferme');\n"]],
  ['f : « coupé » sans confirmation', [API + 'route.ts', "r.revoquee ? 'coupee' : 'coupee_ici'", "'coupee'"]],
  ['f : un seul jeton révoqué suffit', [C + 'oauth.ts', 'return jetons.length > 0 && faits.every(Boolean);', 'return faits.length >= 0;']],
  ['f : service muet pris pour une révocation', [C + 'oauth.ts', '    return jetons.length > 0 && faits.every(Boolean);\n  } catch {\n    return false;', '    return jetons.length > 0 && faits.every(Boolean);\n  } catch {\n    return true;']],
  ['f : coffre illisible dit révoqué', [C + 'coffre.ts', 'const revoquee = c && jetons ? await revoquer(db, c, jetons, retour, d) : false;', 'const revoquee = c && jetons ? await revoquer(db, c, jetons, retour, d) : true;']],
  ['f : le compte supprimé ne dit pas ce qui reste', ['app/api/admin/delete-tenant/route.ts', 'if (!x || x.echecs)', 'if (false)']],
  ['g : le renouvellement écrase une coupure ou un rebranchement', [C + 'coffre.ts', "where: { id: l.id, accesChiffre: l.accesChiffre }, data: { ...sceller(j)", "where: { id: l.id }, data: { ...sceller(j)"]],
  ['g : compte supprimé pendant l\'échange', [C + 'coffre.ts', 'if (!(await db.user.findUnique({ where: { supabaseUserId: hubUserId }, select: { id: true } }))) {', 'if (false) {']],
  ['g : suppression de compte, une seule coupure', ['app/api/admin/delete-tenant/route.ts', '  await couperConnexions();\n\n  // Une suppression', '  // Une suppression']],
  ['g : deux versions renouvellent ensemble', [C + 'coffre.ts', 'if (bail.count === 0) {', 'if (false) {']],
  ['g : un bail mort bloque', [C + 'coffre.ts', 'OR: [{ renouvellementLe: null }, { renouvellementLe: { lt: new Date(now - BAIL_MS) } }]', 'renouvellementLe: null']],
  ['g : une panne laisse le bail', [C + 'coffre.ts', "data: { renouvellementLe: null } });\n      throw", "data: {} });\n      throw"]],
  ['g : jeton neuf rendu malgré la coupure', [C + 'coffre.ts', '    if (count) return j.acces;\n', '    return j.acces;\n']],
  ['g : jeton neuf laissé vivant', [C + 'coffre.ts', 'const revoquee = orphelins.length === 0 ||', 'const revoquee = true ||']],
  ['g : le jeton d\'un autre révoqué sous lui', [C + 'coffre.ts', 'tousLes(j).filter((x) => !gardes.includes(x))', 'tousLes(j)']],
  ['g : la coupure révoque des jetons périmés', [C + 'coffre.ts', 'i < ESSAIS ? { id: l.id, accesChiffre: l.accesChiffre, attenteChiffre: l.attenteChiffre } : { id: l.id }', '{ id: l.id }']],
  ['g : une ligne coupée se rejoue', [C + 'porte.ts', 'if (ecriture === null) throw', 'if (false) throw']],
  ['h : jeton de gestion perdu', [C + 'oauth.ts', 'gestionChiffre: i.jeton ? chiffrer(JSON.stringify({ jeton: i.jeton, adresse: i.adresse })) : null', 'gestionChiffre: null']],
  ['h : jeton de gestion en clair', [C + 'oauth.ts', 'chiffrer(JSON.stringify({ jeton: i.jeton, adresse: i.adresse }))', 'JSON.stringify({ jeton: i.jeton, adresse: i.adresse })']],
  ['h : adresse de gestion ailleurs', [C + 'oauth.ts', 'tenirAdresse(adresse, [c.oauth.enregistrement], d);\n  } catch', '} catch']],
  ['h : effacée chez nous sans confirmation', [C + 'oauth.ts', "adresse: string }, d))) return 'echec';", "adresse: string }, d)) && false) return 'echec';"]],
  ['h : deux inscriptions', [C + 'oauth.ts', 'if (enCours) return enCours;\n  const p = (async () => (await notreClient', 'const p = (async () => (await notreClient']],
  ['h : inscription en double laissée chez lui', [C + 'oauth.ts', 'const efface = await effacerChez(c, i, d);', 'const efface = false;']],
  ['interrupteur : servi alors que c\'est fermé', [C + 'porte.ts', 'const c = connecteursOuverts() ? connecteur(cle) : null;', 'const c = connecteur(cle);']],
  ['interrupteur : brancher alors que c\'est fermé', [API + 'route.ts', "  if (!connecteursOuverts()) return vers('ferme');\n", '']],
];
const TESTS = ['__tests__/lib/connecteurs', '__tests__/api/connecteurs.test.ts', '__tests__/api/connecteurs', '__tests__/app/dashboard/connexions.test.tsx', '__tests__/lib/mcp/porte.test.ts', '__tests__/lib/mcp/oauth.test.ts', '__tests__/lib/mcp/catalogue.test.ts', '__tests__/api/oauth/authorize.test.ts', '__tests__/api/admin/delete-tenant.test.ts', '__tests__/api/admin/connecteurs.test.ts'];
/** Le bilan de vitest, pas son code seul : une suite qui ne démarre pas n'est pas un sabotage vu. */
const jouer = () => {
  const r = spawnSync('npx', ['vitest', 'run', ...TESTS, '--reporter=json', '--silent'], { encoding: 'utf8', maxBuffer: 1e9 });
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{"numTotal')));
    const casses = j.testResults.filter((f) => f.status === 'failed' && f.assertionResults.length === 0).map((f) => `${f.name} ${f.message.slice(0, 120)}`);
    return { total: j.numTotalTests, rouges: j.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.title)), casses };
  } catch {
    return { total: 0, rouges: [], casses: [(r.stderr || r.stdout).slice(-300)] };
  }
};
const temoin = jouer();
if (temoin.total === 0 || temoin.rouges.length || temoin.casses.length) { console.log('✗ NON ABOUTI : rouge sans sabotage', temoin); process.exit(2); }
console.log(`témoin : ${temoin.total} tests verts`);
let inapercus = 0;
let nonAboutis = 0;
for (const [nom, ...gestes] of SABOTAGES.filter(([n]) => n.includes(process.argv[2] ?? ''))) {
  const avant = new Map(gestes.map(([f]) => [f, readFileSync(f, 'utf8')]));
  let ok = true;
  for (const [f, motif, par] of gestes) {
    const t = readFileSync(f, 'utf8');
    if (t.split(motif).length !== 2) { ok = false; console.log(`? NON ABOUTI  ${nom} : motif vu ${t.split(motif).length - 1} fois dans ${f}`); break; }
    writeFileSync(f, t.replace(motif, () => par));
  }
  const r = ok ? jouer() : null;
  for (const [f, t] of avant) writeFileSync(f, t);
  if (!r) nonAboutis += 1;
  else if (r.casses.length || r.total < temoin.total) { nonAboutis += 1; console.log(`? NON ABOUTI  ${nom} : ${r.casses[0] ?? `${r.total} tests`}`); }
  else if (r.rouges.length === 0) { inapercus += 1; console.log(`✗ INAPERÇU    ${nom}`); }
  else console.log(`✓ vu          ${nom} (${r.rouges.length} : ${r.rouges[0].slice(0, 90)})`);
}
console.log(`inaperçus ${inapercus}, non aboutis ${nonAboutis}`);
process.exit(inapercus ? 1 : nonAboutis ? 2 : 0);

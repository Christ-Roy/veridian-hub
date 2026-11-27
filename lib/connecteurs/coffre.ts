/**
 * Les connexions d'une personne à des services extérieurs (VER-119) : jetons chiffrés au repos, jamais rendus, jamais journalisés. Une connexion est à la
 * PERSONNE (`hub_user_id`), pas à l'organisation : personne d'autre ne s'en sert, et elle part avec son compte. Chaque écriture compare ce qu'elle a lu
 * (`accesChiffre`, unique à chaque chiffrement) : une coupure, un renouvellement et un rebranchement peuvent se croiser.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { chiffrer, dechiffrer } from '@/lib/ia/coffre';
import { oublierUtilisateur } from '@/lib/mcp/cache';

import { renouveler, revoquer, type Deps, type Jetons } from './oauth';
import { connecteur, CONNECTEURS, saitEcrire, type Connecteur } from './registre';

type Db = Pick<PrismaClient, 'connecteurClient' | 'connexionExterne' | 'auditLog' | 'user'>;
/** Un jeton qui finit dans la minute est déjà fini. */
const MARGE_MS = 60_000;
const ESSAIS = 5;
/** Au-delà, celui qui renouvelait est mort : un autre reprend. Au-dessus de ses deux requêtes de 10 s. */
const BAIL_MS = 25_000;

const ou = (hubUserId: string, cle: string) => ({ hubUserId_connecteur: { hubUserId, connecteur: cle } });
const tracer = (db: Db, hubUserId: string, geste: string, payload: Record<string, unknown>) =>
  writeAuditLog(db as PrismaClient, { action: `connecteur.${geste}`, actor: `user:${hubUserId}`, targetType: 'user', targetId: hubUserId, payload: payload as never });

const sceller = (j: Jetons) => ({ accesChiffre: chiffrer(j.acces), refreshChiffre: j.refresh ? chiffrer(j.refresh) : null, expireLe: j.expireLe });
const scellerAttente = (j: Jetons): string => chiffrer(JSON.stringify({ ...j, expireLe: j.expireLe?.getTime() ?? null }));
function ouvrirAttente(scelle: string): Jetons {
  const x = JSON.parse(dechiffrer(scelle)) as Omit<Jetons, 'expireLe'> & { expireLe: number | null };
  return { ...x, expireLe: x.expireLe === null ? null : new Date(x.expireLe) };
}
/** Illisible (clé du coffre changée) : rien à révoquer, et ça ne doit pas passer pour révoqué. */
const ouvrirOuRien = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};
const tousLes = (j: Pick<Jetons, 'acces' | 'refresh'>): string[] => [...(j.refresh ? [j.refresh] : []), j.acces];

type Ligne = NonNullable<Awaited<ReturnType<Db['connexionExterne']['findUnique']>>>;
/** Tous les jetons d'une ligne, celui en attente compris. Null : au moins un est illisible. */
function jetonsDe(l: Pick<Ligne, 'accesChiffre' | 'refreshChiffre' | 'attenteChiffre'>, attente = true): string[] | null {
  return ouvrirOuRien(() => [
    ...(l.refreshChiffre ? [dechiffrer(l.refreshChiffre)] : []),
    dechiffrer(l.accesChiffre),
    ...(attente && l.attenteChiffre ? tousLes(ouvrirAttente(l.attenteChiffre)) : []),
  ]);
}

/**
 * Garde des jetons neufs. Une connexion existe déjà, vivante ou non : on ne sait pas si c'est le même compte chez le service, donc rien n'est remplacé ; les
 * neufs attendent que la personne choisisse, l'ancienne continue.
 */
export async function garder(db: Db, hubUserId: string, cle: string, j: Jetons, retour: string, d: Deps = {}): Promise<'branchee' | 'a_confirmer'> {
  let r: 'branchee' | 'a_confirmer';
  try {
    r = await poserOuAttendre(db, hubUserId, cle, j, retour, d);
  } catch (err) {
    // Rien n'est gardé : ce que le service vient de donner n'y reste pas.
    const c = connecteur(cle);
    const revoquee = c ? await revoquer(db, c, tousLes(j), retour, d) : false;
    console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'jeton neuf non gardé', connecteur: cle, revoquee }));
    throw err;
  }
  // Compte supprimé pendant l'échange, après que ses connexions ont été coupées : celle-ci ne lui survit pas. (Supprimé après cette lecture : la suppression
  // coupe une seconde fois, une fois le compte parti.)
  if (!(await db.user.findUnique({ where: { supabaseUserId: hubUserId }, select: { id: true } }))) {
    await couper(db, hubUserId, cle, retour, d);
    throw new Error('compte_absent');
  }
  return r;
}

async function poserOuAttendre(db: Db, hubUserId: string, cle: string, j: Jetons, retour: string, d: Deps): Promise<'branchee' | 'a_confirmer'> {
  const now = new Date(d.now ?? Date.now());
  for (let i = 0; i < ESSAIS; i++) {
    const l = await db.connexionExterne.findUnique({ where: ou(hubUserId, cle) });
    if (!l) {
      const cree = await db.connexionExterne.create({ data: { hubUserId, connecteur: cle, ...sceller(j), compte: j.compte, etat: 'active', renouveleLe: now } }).then(() => true, (err: { code?: string }) => {
        if (err.code === 'P2002') return false;
        throw err;
      });
      if (!cree) continue;
      oublierUtilisateur(hubUserId, cle);
      await tracer(db, hubUserId, 'branche', { connecteur: cle });
      return 'branchee';
    }
    const { count } = await db.connexionExterne.updateMany({ where: { id: l.id, accesChiffre: l.accesChiffre, attenteChiffre: l.attenteChiffre }, data: { attenteChiffre: scellerAttente(j), attenteCompte: j.compte } });
    if (count === 0) continue;
    // Une attente d'avant, jamais tranchée : elle ne reste pas vivante chez lui.
    const c = connecteur(cle);
    const avant = l.attenteChiffre ? ouvrirOuRien(() => ouvrirAttente(l.attenteChiffre!)) : null;
    const revoquee = c && avant ? await revoquer(db, c, tousLes(avant), retour, d) : undefined;
    await tracer(db, hubUserId, 'rebranche', { connecteur: cle, ...(l.attenteChiffre ? { attente_revoquee: revoquee ?? false } : {}) });
    return 'a_confirmer';
  }
  throw new Error('concurrence');
}

/** La personne tranche un rebranchement : prendre le compte neuf (l'ancien est révoqué), ou garder l'ancien (le neuf est révoqué). */
export async function trancher(db: Db, hubUserId: string, cle: string, choix: 'remplacer' | 'garder', retour: string, d: Deps = {}): Promise<{ fait: boolean; revoquee: boolean }> {
  const c = connecteur(cle);
  for (let i = 0; c && i < ESSAIS; i++) {
    const l = await db.connexionExterne.findUnique({ where: ou(hubUserId, cle) });
    if (!l?.attenteChiffre) return { fait: false, revoquee: false };
    const neufs = ouvrirOuRien(() => ouvrirAttente(l.attenteChiffre!));
    if (!neufs && choix === 'remplacer') return { fait: false, revoquee: false };
    const anciens = jetonsDe(l, false);
    const vide = { attenteChiffre: null, attenteCompte: null };
    const now = new Date(d.now ?? Date.now());
    // Un autre compte : l'écriture se rallume, elle ne s'hérite pas.
    const data = choix === 'remplacer' ? { ...sceller(neufs!), ...vide, compte: neufs!.compte, etat: 'active', ecriture: false, creeLe: now, renouveleLe: now, renouvellementLe: null } : vide;
    const { count } = await db.connexionExterne.updateMany({ where: { id: l.id, accesChiffre: l.accesChiffre, attenteChiffre: l.attenteChiffre }, data });
    if (count === 0) continue;
    oublierUtilisateur(hubUserId, cle);
    const aRevoquer = choix === 'remplacer' ? anciens?.filter((x) => !tousLes(neufs!).includes(x)) : neufs && tousLes(neufs).filter((x) => !(anciens ?? []).includes(x));
    const revoquee = aRevoquer ? aRevoquer.length === 0 || (await revoquer(db, c, aRevoquer, retour, d)) : false;
    await tracer(db, hubUserId, choix === 'remplacer' ? 'remplace' : 'garde', { connecteur: cle, revoquee });
    return { fait: true, revoquee };
  }
  if (!c) return { fait: false, revoquee: false };
  throw new Error('concurrence');
}

/** L'interrupteur d'écriture d'UN service, à la personne. Éteindre vaut pour l'appel suivant. */
export async function reglerEcriture(db: Db, hubUserId: string, c: Connecteur, ecriture: boolean): Promise<boolean> {
  if (ecriture && !saitEcrire(c)) return false;
  const { count } = await db.connexionExterne.updateMany({ where: { hubUserId, connecteur: c.cle, ...(ecriture ? { etat: 'active' } : {}) }, data: { ecriture } });
  oublierUtilisateur(hubUserId, c.cle);
  if (count) await tracer(db, hubUserId, ecriture ? 'ecriture_allumee' : 'ecriture_eteinte', { connecteur: c.cle });
  return count > 0;
}

export type EtatConnexion = {
  cle: string; nom: string; texte: string; etat: 'absente' | 'active' | 'a_rebrancher'; depuis: string | null; compte: string | null;
  ecriture: boolean; saitEcrire: boolean; /** Au moins un outil relu : sinon rien n'est servi. */ relu: boolean; /** Un rebranchement à trancher. */ attente: { compte: string | null } | null;
};
export async function connexionsDe(db: Pick<PrismaClient, 'connexionExterne'>, hubUserId: string): Promise<EtatConnexion[]> {
  const l = await db.connexionExterne.findMany({ where: { hubUserId }, select: { connecteur: true, etat: true, creeLe: true, compte: true, ecriture: true, attenteChiffre: true, attenteCompte: true } });
  return CONNECTEURS.map((c) => {
    const x = l.find((y) => y.connecteur === c.cle);
    return {
      cle: c.cle, nom: c.nom, texte: c.texte, etat: !x ? 'absente' : x.etat === 'active' ? 'active' : 'a_rebrancher', depuis: x?.creeLe.toISOString() ?? null, compte: x?.compte ?? null,
      ecriture: x?.ecriture === true, saitEcrire: saitEcrire(c), relu: Object.keys(c.outils).length > 0, attente: x?.attenteChiffre ? { compte: x.attenteCompte } : null,
    };
  });
}

/** Un seul renouvellement à la fois par connexion : le service tourne souvent le jeton, deux renouvellements le perdraient. */
const enCours = new Map<string, Promise<string | null>>();

/** Le jeton d'accès valable, renouvelé s'il le faut. Null : à rebrancher, ou absente. `force` : le service vient de le refuser. */
export async function jetonDe(db: Db, hubUserId: string, c: Connecteur, retour: string, d: Deps & { force?: boolean } = {}): Promise<string | null> {
  const now = d.now ?? Date.now();
  const l = await db.connexionExterne.findUnique({ where: ou(hubUserId, c.cle) });
  if (!l || l.etat !== 'active') return null;
  if (!d.force && (!l.expireLe || l.expireLe.getTime() - MARGE_MS > now)) return dechiffrer(l.accesChiffre);
  const k = l.id;
  const deja = enCours.get(k);
  if (deja) return deja;
  const p = (async () => {
    /** Ce que la base dit maintenant : coupée, rebranchée, ou renouvelée par l'autre version pendant une bascule. */
    const relire = async () => db.connexionExterne.findUnique({ where: { id: l.id } });
    const vivant = (r: Ligne | null) => (r?.etat === 'active' ? dechiffrer(r.accesChiffre) : null);
    const aRebrancher = async () => {
      const { count } = await db.connexionExterne.updateMany({ where: { id: l.id, accesChiffre: l.accesChiffre }, data: { etat: 'a_rebrancher' } });
      return count ? null : vivant(await relire());
    };
    if (!l.refreshChiffre) return aRebrancher();
    const ancien = dechiffrer(l.refreshChiffre);
    // Deux versions servent ensemble pendant une bascule : un même jeton de renouvellement présenté deux fois ferait tout révoquer par le service.
    const bail = await db.connexionExterne.updateMany({
      where: { id: l.id, accesChiffre: l.accesChiffre, OR: [{ renouvellementLe: null }, { renouvellementLe: { lt: new Date(now - BAIL_MS) } }] },
      data: { renouvellementLe: new Date(now) },
    });
    if (bail.count === 0) {
      for (let i = 0; i < 40; i++) {
        const r = await relire();
        if (r?.etat !== 'active' || r.accesChiffre !== l.accesChiffre) return vivant(r);
        await new Promise((ok) => setTimeout(ok, d.attenteMs ?? 250));
      }
      throw new Error('service_injoignable');
    }
    let j: Jetons;
    try {
      j = await renouveler(db, c, ancien, retour, d);
    } catch (err) {
      // Refusé par le service : à rebrancher. Injoignable : on ne conclut rien, le prochain appel réessaie.
      const refuse = (err as { error?: string }).error === 'invalid_grant' || (err as { error?: string }).error === 'invalid_client';
      console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'renouvellement', connecteur: c.cle, code: (err as { code?: string; error?: string }).error ?? (err as { code?: string }).code ?? 'erreur' }));
      if (refuse) return aRebrancher();
      await db.connexionExterne.updateMany({ where: { id: l.id, accesChiffre: l.accesChiffre }, data: { renouvellementLe: null } });
      throw new Error('service_injoignable');
    }
    const { count } = await db.connexionExterne.updateMany({ where: { id: l.id, accesChiffre: l.accesChiffre }, data: { ...sceller(j), etat: 'active', renouveleLe: new Date(now), renouvellementLe: null } });
    if (count) return j.acces;
    // Coupée (ou remplacée) pendant l'échange : le neuf n'a plus de propriétaire. Révoqué, jamais rendu. Un jeton encore en service ailleurs ne l'est pas.
    const r = await relire();
    const gardes = r ? [...(jetonsDe(r) ?? []), ancien] : [];
    const orphelins = tousLes(j).filter((x) => !gardes.includes(x));
    const revoquee = orphelins.length === 0 || (await revoquer(db, c, orphelins, retour, d));
    console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'jeton neuf sans connexion', connecteur: c.cle, revoquee }));
    await tracer(db, hubUserId, 'jeton_orphelin', { connecteur: c.cle, revoquee });
    return vivant(r);
  })().finally(() => enCours.delete(k));
  enCours.set(k, p);
  return p;
}

/** Coupe : effacée chez nous quoi qu'il arrive. `revoquee` : le service a confirmé la coupure de TOUS ses jetons ; sinon l'accès vit peut-être encore chez lui. */
export async function couper(db: Db, hubUserId: string, cle: string, retour: string, d: Deps = {}): Promise<{ coupee: boolean; revoquee: boolean }> {
  const c = connecteur(cle);
  let l = await db.connexionExterne.findUnique({ where: ou(hubUserId, cle) });
  if (!l) return { coupee: false, revoquee: false };
  for (let i = 0; ; i++) {
    // Ce qui part est ce qu'on révoquera : un renouvellement ou un rebranchement glissé entre la lecture et l'effacement se relit.
    const { count } = await db.connexionExterne.deleteMany({ where: i < ESSAIS ? { id: l.id, accesChiffre: l.accesChiffre, attenteChiffre: l.attenteChiffre } : { id: l.id } });
    if (count) break;
    const r: Ligne | null = await db.connexionExterne.findUnique({ where: { id: l.id } });
    if (!r) return { coupee: false, revoquee: false };
    l = r;
  }
  oublierUtilisateur(hubUserId, cle);
  const jetons = jetonsDe(l);
  const revoquee = c && jetons ? await revoquer(db, c, jetons, retour, d) : false;
  await tracer(db, hubUserId, 'coupe', { connecteur: cle, revoquee });
  return { coupee: true, revoquee };
}

/** Un compte supprimé n'en laisse aucune. Une qui échoue n'empêche pas les autres, et se compte. */
export async function couperToutes(db: Db, hubUserId: string, retour: string, d: Deps = {}): Promise<{ coupees: number; nonConfirmees: number; echecs: number }> {
  const l = await db.connexionExterne.findMany({ where: { hubUserId }, select: { connecteur: true } });
  const r = { coupees: 0, nonConfirmees: 0, echecs: 0 };
  for (const x of l) {
    const y = await couper(db, hubUserId, x.connecteur, retour, d).catch(() => null);
    if (!y) r.echecs += 1;
    else if (y.coupee) {
      r.coupees += 1;
      if (!y.revoquee) r.nonConfirmees += 1;
    }
  }
  return r;
}

/**
 * « Mon IA » : branchement, interrupteurs et sessions (docs/MON-IA.md). Le Hub ne garde aucune conversation.
 */
import type { PrismaClient } from '@prisma/client';

import { chiffrer, dechiffrer, empreinteCle, finDeCle } from './coffre';

export const FOURNISSEURS = {
  anthropic: { nom: 'Anthropic', modele: 'claude-sonnet-5-5' },
  openai: { nom: 'OpenAI', modele: 'gpt-5.1' },
  mistral: { nom: 'Mistral', modele: 'mistral-large-latest' },
  openrouter: { nom: 'OpenRouter', modele: 'anthropic/claude-sonnet-5.5' },
} as const;
export type Fournisseur = keyof typeof FOURNISSEURS;
export const estFournisseur = (v: unknown): v is Fournisseur => typeof v === 'string' && v in FOURNISSEURS;

/** Apps qui peuvent porter le chat (une app s'ajoute ici quand elle range ses fils). */
export const APPS_CHAT = ['academy', 'crm', 'notifuse', 'prospection', 'analytics'] as const;
export const estAppChat = (v: unknown): v is (typeof APPS_CHAT)[number] =>
  typeof v === 'string' && (APPS_CHAT as readonly string[]).includes(v);

/**
 * Apps dont le chat est la fenêtre du Hub (/ia/chat). Le CRM n'en est plus : il a son chat natif, servi par le
 * fournisseur « Veridian » (/api/ia/v1), et le plugin Assistant 0.2.0 a retiré sa page iframe (23/11). Son
 * interrupteur (APPS_CHAT) reste : le chat natif le lit.
 */
export const estAppFenetre = (v: unknown): v is Exclude<(typeof APPS_CHAT)[number], 'crm'> => estAppChat(v) && v !== 'crm';

type Db = Pick<PrismaClient, 'iaBranchement' | 'iaActivation' | 'iaSession'>;

/** Ce que le navigateur peut voir d'un branchement : jamais la clé, seulement sa fin. */
export type VueBranchement = { fournisseur: Fournisseur | 'claude-abonnement'; modele: string; cleFin: string; moteur: string; misAJour: string };

export async function brancher(
  db: Db,
  hubUserId: string,
  entree: { fournisseur: Fournisseur; modele?: string | null; cle: string },
  env?: NodeJS.ProcessEnv,
): Promise<VueBranchement> {
  const cle = entree.cle.trim();
  if (cle.length < 16 || /\s/.test(cle)) throw new Error('cle_invalide');
  const modele = (entree.modele?.trim() || FOURNISSEURS[entree.fournisseur].modele).slice(0, 120);
  const donnees = {
    moteur: 'cle-api',
    modele,
    cleScellee: chiffrer(cle, env),
    cleEmpreinte: empreinteCle(cle),
    cleFin: finDeCle(cle),
  };
  const b = await db.iaBranchement.upsert({
    where: { hubUserId_fournisseur: { hubUserId, fournisseur: entree.fournisseur } },
    create: { hubUserId, fournisseur: entree.fournisseur, ...donnees },
    update: donnees,
  });
  return vue(b);
}

function vue(b: { fournisseur: string; modele: string; cleFin: string; moteur: string; updatedAt: Date }): VueBranchement {
  return { fournisseur: b.fournisseur as VueBranchement['fournisseur'], modele: b.modele, cleFin: b.cleFin, moteur: b.moteur, misAJour: b.updatedAt.toISOString() };
}

export async function branchementsDe(db: Db, hubUserId: string): Promise<VueBranchement[]> {
  const rows = await db.iaBranchement.findMany({ where: { hubUserId }, orderBy: { updatedAt: 'desc' } });
  return rows.map(vue);
}

export async function revoquer(db: Db, hubUserId: string, fournisseur: Fournisseur): Promise<boolean> {
  const r = await db.iaBranchement.deleteMany({ where: { hubUserId, fournisseur } });
  return r.count > 0;
}

/** La clé en clair, pour l'appel en cours seulement. */
export async function cleEnClair(
  db: Db,
  hubUserId: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ fournisseur: Fournisseur; modele: string; cle: string } | null> {
  const b = await db.iaBranchement.findFirst({ where: { hubUserId, moteur: 'cle-api' }, orderBy: { updatedAt: 'desc' } });
  if (!b || !estFournisseur(b.fournisseur)) return null;
  return { fournisseur: b.fournisseur, modele: b.modele, cle: dechiffrer(b.cleScellee, env) };
}

/**
 * Le moteur du compte. L'abonnement passe devant toute clé : il est déjà payé par le client, alors qu'une clé se
 * paie à la question (22/11 : une clé sans crédit rangée après l'abonnement aurait coupé le chat de Robert).
 * Sinon, la clé du dernier branchement.
 */
export async function moteurActif(db: Db, hubUserId: string): Promise<'cle-api' | 'claude-code-abonnement' | null> {
  const abonnement = await db.iaBranchement.findFirst({ where: { hubUserId, moteur: 'claude-code-abonnement' }, select: { moteur: true } });
  if (abonnement) return 'claude-code-abonnement';
  const b = await db.iaBranchement.findFirst({ where: { hubUserId }, orderBy: { updatedAt: 'desc' }, select: { moteur: true } });
  if (!b) return null;
  return b.moteur === 'claude-code-abonnement' ? 'claude-code-abonnement' : 'cle-api';
}

// ── Interrupteurs : allumés d'office, retrait volontaire par app et espace ──

export async function activer(db: Db, t: { hubUserId: string; app: string; tenantId: string }, enabled: boolean) {
  await db.iaActivation.upsert({
    where: { hubUserId_app_tenantId: t },
    create: { ...t, enabled },
    update: { enabled },
  });
}

/**
 * L'assistant est allumé d'office dans toutes les apps des espaces de l'utilisateur dès qu'une IA est branchée
 * (Robert, 23/11 : « SSO-like, je ne veux pas avoir à cliquer »). Seul un retrait volontaire (ligne à `enabled =
 * false`) l'éteint pour une app et un espace. La vérification que l'espace est à l'utilisateur reste à l'appelant
 * (espaceDe), et la session reste liée au triplet (menace 7).
 */
export async function estActive(db: Db, t: { hubUserId: string; app: string; tenantId: string }): Promise<boolean> {
  const a = await db.iaActivation.findUnique({ where: { hubUserId_app_tenantId: t } });
  return a ? a.enabled : true;
}

// ── Sessions (menace 7) : créées par le Hub, reprises seulement pour leur triplet ──

export type Triplet = { hubUserId: string; app: string; tenantId: string };

/**
 * Reprend la session `id` si elle appartient exactement au triplet ; sinon refuse (null). Sans `id`,
 * en crée une. Le navigateur et le modèle ne choisissent jamais l'identifiant d'une session neuve.
 */
export async function ouvrirSession(db: Db, t: Triplet, moteur: string, id?: string | null): Promise<{ id: string } | null> {
  if (id) {
    const s = await db.iaSession.findUnique({ where: { id } }).catch(() => null);
    if (!s || s.hubUserId !== t.hubUserId || s.app !== t.app || s.tenantId !== t.tenantId || s.moteur !== moteur) return null;
    await db.iaSession.update({ where: { id }, data: { lastUsedAt: new Date() } });
    return { id: s.id };
  }
  const s = await db.iaSession.create({ data: { ...t, moteur } });
  return { id: s.id };
}

/**
 * Session d'un fil d'une app qui garde ses fils elle-même (chat natif de Twenty) : l'identifiant est dérivé par le Hub
 * du triplet et du fil (sessionDuFil). Créée au premier appel ; reprise seulement pour ce triplet et ce moteur.
 */
export async function sessionDerivee(db: Db, t: Triplet, moteur: string, id: string): Promise<{ id: string; creee: boolean } | null> {
  const s = await db.iaSession.findUnique({ where: { id } }).catch(() => null);
  if (s) {
    if (s.hubUserId !== t.hubUserId || s.app !== t.app || s.tenantId !== t.tenantId || s.moteur !== moteur) return null;
    await db.iaSession.update({ where: { id }, data: { lastUsedAt: new Date() } });
    return { id, creee: false };
  }
  await db.iaSession.create({ data: { id, ...t, moteur } });
  return { id, creee: true };
}

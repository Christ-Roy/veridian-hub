/**
 * De l'identité affirmée par le fournisseur d'une organisation au compte du Hub (VER-227 S2, SSO-ORGANISATIONS §3.A et §6 M2, M3).
 * La clé durable est (fournisseur, `sub`), jamais l'adresse. L'adresse ne vaut que dans les domaines que NOUS avons déclarés pour lui.
 * Un compte existant et prouvé n'est JAMAIS repris par son adresse : sa personne le relie elle-même, connectée, une fois.
 */
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { applyProviderEmailProof } from '@/lib/auth/email-proof-provider';
import { suivreOrganisation } from '@/lib/organisations/emission';
import { isTestAccount } from '@/lib/sync/test-residue';
import { RefusMembre, rejoindre, type DbMembres } from '@/lib/tenants/membres';
import { pousserRole } from '@/lib/tenants/roles';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';

import type { IdpPret } from './idp';
import type { Identite } from './oidc';

export type RefusFederation = 'adresse_absente' | 'adresse_non_verifiee' | 'domaine_refuse' | 'compte_existant' | 'autre_identite' | 'non_attendu' | 'retire' | 'organisation_indisponible';
type Db = DbMembres & Pick<PrismaClient, 'account' | 'tenantPreinscription' | 'organisation' | 'organisationEmission'>;
/** La personne déjà connectée au Hub, preuve récente, jamais une session d'emprunt : la seule qui puisse relier un compte existant. */
export type Connecte = { userId: string; email: string } | null;

export const fournisseur = (i: Pick<IdpPret, 'id'>): string => `org:${i.id}`;

export async function resoudreIdentite(db: Db, i: IdpPret, x: Identite, connecte: Connecte, deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<{ userId: string; hubUserId: string; neuf: boolean } | { refus: RefusFederation }> {
  const provider = fournisseur(i);
  const lien = await db.account.findUnique({ where: { provider_providerAccountId: { provider, providerAccountId: x.sub } }, select: { userId: true } });
  if (lien) {
    const u = await db.user.findUnique({ where: { id: lien.userId }, select: { id: true, email: true, supabaseUserId: true } });
    if (!u?.supabaseUserId || (i.test && !isTestAccount(u.email))) return { refus: 'non_attendu' };
    return entrer(db, i, { userId: u.id, hubUserId: u.supabaseUserId, neuf: false }, deps);
  }

  if (!x.email || !/^[^\s@]+@[^\s@]+$/.test(x.email)) return { refus: 'adresse_absente' };
  if (x.emailNie) return { refus: 'adresse_non_verifiee' };
  if (!i.domaines.includes(x.email.split('@')[1])) return { refus: 'domaine_refuse' };
  // Une organisation de test ne peut affirmer que des comptes de batterie, même dans nos domaines.
  if (i.test && !isTestAccount(x.email)) return { refus: 'domaine_refuse' };

  const u = await db.user.findUnique({ where: { email: x.email }, select: { id: true, email: true, supabaseUserId: true, emailVerified: true } });
  if (u) {
    if (!u.supabaseUserId) return { refus: 'compte_existant' };
    // Une autre identité du MÊME fournisseur tient déjà ce compte : adresse recyclée (AD-M1), jamais reliée en silence.
    if (await db.account.findFirst({ where: { userId: u.id, provider }, select: { id: true } })) return { refus: 'autre_identite' };
    const estElle = connecte?.userId === u.id && connecte.email.toLowerCase() === x.email;
    // Jamais prouvé : le fournisseur du domaine est la PREMIÈRE preuve. Ce qui avait été posé avant (mot de passe, liens, sessions) tombe (M2).
    if (u.emailVerified && !estElle) return { refus: 'compte_existant' };
    if (!u.emailVerified) await applyProviderEmailProof(db as never, u.id, provider, { providerAccountId: x.sub, sessions: 'toujours' });
    await relier(db, i, u.id, x.sub);
    return entrer(db, i, { userId: u.id, hubUserId: u.supabaseUserId, neuf: false }, deps);
  }

  const attendu = i.creationAuto || (await db.tenantPreinscription.count({ where: { tenantId: i.tenantId, email: x.email, consommeeLe: null, annuleeLe: null, expireLe: { gt: new Date() } } })) > 0;
  if (!attendu) return { refus: 'non_attendu' };
  const hubUserId = randomUUID();
  const cree = await db.user.create({ data: { email: x.email, name: x.nom, emailVerified: new Date(), supabaseUserId: hubUserId }, select: { id: true } });
  await relier(db, i, cree.id, x.sub);
  await provisionDefaultWorkspace({ userId: cree.id, email: x.email, name: x.nom }, { prisma: db as unknown as PrismaClient, actor: 'system:federation' }).catch((err) => console.error('[federation] workspace', err instanceof Error ? err.message.slice(0, 160) : 'erreur'));
  return entrer(db, i, { userId: cree.id, hubUserId, neuf: true }, deps);
}

async function relier(db: Db, i: IdpPret, userId: string, sub: string): Promise<void> {
  await db.account.create({ data: { userId, type: 'oidc', provider: fournisseur(i), providerAccountId: sub } });
  await writeAuditLog(db as unknown as PrismaClient, { action: 'federation.relie', actor: fournisseur(i), targetType: 'user', targetId: userId, payload: { tenant_id: i.tenantId } });
}

/** Appartenance, additive : un membre retiré au Hub ne revient pas par son fournisseur (M13), seul un geste neuf le fait. */
async function entrer(db: Db, i: IdpPret, qui: { userId: string; hubUserId: string; neuf: boolean }, deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }) {
  try {
    const r = await rejoindre(db, { tenantId: i.tenantId, hubUserId: qui.hubUserId, origine: 'federation', acteur: fournisseur(i) });
    if (r.cree) {
      await suivreOrganisation(db, i.tenantId, deps);
      await pousserRole(db, { tenantId: i.tenantId, hubUserId: qui.hubUserId }, deps).catch(() => undefined);
    }
    return qui;
  } catch (err) {
    if (!(err instanceof RefusMembre)) throw err;
    return { refus: err.code === 'retire' ? ('retire' as const) : ('organisation_indisponible' as const) };
  }
}

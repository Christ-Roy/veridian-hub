/**
 * Une session ouverte par le fournisseur d'une organisation n'ouvre QUE cette organisation (VER-261). Les apps, la porte IA et les liaisons suivent la
 * PERSONNE, avec toutes ses organisations : la borner chez chacune serait un filtre par porte. On borne donc la session elle-même : quelqu'un qui appartient
 * aussi ailleurs (son propre espace compris) n'a pas de session fédérée, et celle qui vit tombe à la lecture suivante. Il entre par sa propre connexion.
 */
import type { PrismaClient } from '@prisma/client';

import { federationExpiree, joursValables, type JetonFedere } from './duree';

export type DbBorne = Pick<PrismaClient, 'user' | 'tenant' | 'tenantMember' | 'tenantIdp'>;

/** Toutes ses organisations vivantes ou suspendues, les siennes et celles dont elle est membre : celle-ci, et aucune autre. */
export async function seulementIci(db: Pick<DbBorne, 'tenant' | 'tenantMember'>, hubUserId: string, tenantId: string): Promise<boolean> {
  const membre = await db.tenantMember.findMany({ where: { userId: hubUserId, deletedAt: null }, select: { tenantId: true } });
  const lus = await db.tenant.findMany({ where: { deletedAt: null, OR: [{ userId: hubUserId }, { id: { in: membre.map((m) => m.tenantId) } }] }, select: { id: true } });
  return lus.length === 1 && lus[0].id === tenantId;
}

/** Sans organisation connue (session d'avant la borne), compte disparu ou lecture ratée : hors borne. Une session de 24 h se rouvre en un clic. */
export async function horsDeSaBorne(db: DbBorne, token: JetonFedere & { federeOrg?: unknown; uid?: unknown }): Promise<boolean> {
  if (token.federe !== true) return false;
  if (typeof token.federeOrg !== 'string' || typeof token.uid !== 'string') return true;
  try {
    // Le fournisseur coupé ou retiré ferme ce qu'il avait ouvert ; la durée réglée aujourd'hui vaut pour les sessions d'hier.
    const i = await db.tenantIdp.findUnique({ where: { tenantId: token.federeOrg }, select: { actif: true, sessionJours: true } });
    if (!i?.actif || federationExpiree(token, undefined, joursValables(i.sessionJours))) return true;
    const u = await db.user.findUnique({ where: { id: token.uid }, select: { supabaseUserId: true } });
    return !u?.supabaseUserId || !(await seulementIci(db, u.supabaseUserId, token.federeOrg));
  } catch (err) {
    console.error('[federation] borne illisible', err instanceof Error ? err.message.slice(0, 160) : 'erreur');
    return true;
  }
}

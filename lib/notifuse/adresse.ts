/**
 * L'adresse que le Hub garde pour l'espace Mail d'un tenant (`notifuse_user_email`) : les mails d'essai y partent, et l'entrée directe la cite. Elle suit
 * l'adresse principale de son propriétaire une fois que Mail l'a suivie, jamais avant : sinon on écrirait à une adresse quittée, ou à un inconnu.
 */
import type { PrismaClient } from '@prisma/client';

export async function suivreAdresseMail(db: Pick<PrismaClient, 'tenant'>, hubUserId: string, email: string): Promise<number> {
  return (await db.tenant.updateMany({ where: { userId: hubUserId, deletedAt: null, notifuseUserEmail: { not: null } }, data: { notifuseUserEmail: email } })).count;
}

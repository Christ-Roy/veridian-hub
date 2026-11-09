'use server';

import { revalidatePath } from 'next/cache';

import { getCurrentUser } from '@/lib/auth/get-user';
import { couperConnexion } from '@/lib/mcp/connexions';
import { prisma } from '@/lib/prisma';

export async function couperConnexionIa(formData: FormData) {
  const user = await getCurrentUser();
  const id = formData.get('connexion');
  if (!user?.supabaseUserId || typeof id !== 'string') return;
  if (await couperConnexion(prisma, user.supabaseUserId, id)) {
    await prisma.auditLog.create({ data: { action: 'mcp.oauth.revoke', actor: `user:${user.supabaseUserId}`, targetType: 'oauth_family', targetId: id } }).catch(() => {});
  }
  revalidatePath('/dashboard/ia');
}

/**
 * Les apps ouvertes d'un compte, lues en base : ce que le sélecteur de l'en-tête affiche.
 * Même calcul que la page du tableau de bord (`appsOuvertes`), mêmes lectures. Toute lecture ratée : liste vide, l'en-tête ne casse jamais une page.
 */
import { outilsDe } from '@/app/dashboard/components/OutilsOrganisation';
import { resolveAnalyticsCardTarget } from '@/lib/analytics/dashboard-target';
import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { getEnabledGatedApps } from '@/lib/tenant-apps';
import { organisationsSeules } from '@/lib/tenants/membre-seul';

import { appsOuvertes, etatApps, notesTenant, type AppOuverte } from './apps-ouvertes';

const NOMS_ORGANISATION: Record<string, string> = { crm: 'CRM', notifuse: 'Mail', prospection: 'Prospection', academy: 'Academy' };

export async function appsOuvertesDe(user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>): Promise<AppOuverte[]> {
  try {
    const activees = await getEnabledGatedApps(prisma, userUuid(user));
    // Un salarié sans espace à lui : les apps de son organisation (Academy seulement activée).
    const organisations = await organisationsSeules(prisma, userUuid(user)).catch(() => []);
    if (organisations.length > 0) {
      const academyActivee = etatApps({ tenant: null, activees }).academy;
      const vues = new Set<string>();
      return organisations.flatMap((o) => outilsDe(o, academyActivee)).flatMap(({ cle, url }) => {
        if (vues.has(cle)) return [];
        vues.add(cle);
        return [{ cle: cle as AppOuverte['cle'], nom: NOMS_ORGANISATION[cle] ?? cle, href: url }];
      });
    }
    const tenant = await prisma.tenant.findFirst({
      where: { userId: userUuid(user), deletedAt: null },
      select: { prospectionProvisionedAt: true, notifuseWorkspaceSlug: true, notifusePlan: true, metadata: true },
    });
    const prouvee = await isEmailProvenForSession(user.id);
    const notes = notesTenant(tenant);
    const cible = await resolveAnalyticsCardTarget({
      email: prouvee ? user.email : null,
      hubUserId: prouvee ? userUuid(user) : null,
      metadataFallbackUrl: notes.analytics?.fallback_url,
      metadataTenantName: notes.analytics?.tenant_name,
    });
    return appsOuvertes({ tenant, activees, sitesAnalytics: cible.siteCount }, cible.url);
  } catch (err) {
    console.error('[apps-ouvertes]', err instanceof Error ? err.message.slice(0, 160) : 'erreur');
    return [];
  }
}

/**
 * Déprovisionnement des apps à la suppression d'un compte au Hub. Sans lui, chaque compte supprimé
 * laissait ses espaces dans les apps (09/11 : 145 tenants Prospection orphelins en 3 jours, un par
 * run de la batterie). Le Hub est la source des comptes : quand il en retire un, chaque app retire
 * l'espace correspondant, par sa route du contrat.
 *
 * - Prospection : soft-delete §5.8.1 (données gardées jusqu'à la purge, restaurables). Délai de
 *   grâce : 90 jours pour un client, aucun pour un compte de test (`e2e-sso-*@veridian.site`).
 * - Notifuse : `DELETE /api/tenants/<slug>`, que Notifuse traite en soft-delete (`SoftDelete`, écritures
 *   refusées en 402 `tenant_soft_deleted`).
 * - Twenty : suppression de l'espace (`DELETE /api/tenants/<tenant Hub>`), s'il a été créé.
 * - Rybbit (Analytics) : `DELETE /api/tenants/<tenant Hub>` (27/11 ; avant, rien : organisation, membres et fils Mon IA
 *   restaient). Rybbit décide selon §3.8 : `purge` si tous les membres sont des comptes de test, sinon `conserve`
 *   (organisation suspendue, sites et rapports gardés, fils Mon IA supprimés). 200 et 404 valent « fait ».
 * Chaque issue est rendue : un échec ne bloque pas la suppression au Hub, `hub reconcile` le voit.
 * Le Hub est la source (parente, 27/11) : l'état Prospection (`metadata.prospection_status` = `deleted`, lu par `hub reconcile`) se pose ICI, sur la
 * réponse synchrone du soft-delete, au succès seulement. L'écho `tenant.soft_deleted` de Prospection n'est jamais arrivé (aucun planificateur ne vidait
 * sa file depuis le 19/06) : on ne l'attend plus.
 */
import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { estCompteDeTest } from '@/lib/email/compte-de-test';
import { entetesSignature } from '@/lib/hmac/signature-hub';
import { NotifuseClient } from '@/lib/notifuse/client';
import { createProspectionClientFromEnv } from '@/lib/prospection/client';
import { prisma } from '@/lib/prisma';
import { fusionnerMetadata } from '@/lib/tenants/metadata-fusion';

export const GRACE_JOURS = 90;

export type TenantADeprovisionner = {
  id: string;
  notifuseWorkspaceSlug: string | null;
  prospectionProvisionedAt: Date | null;
  metadata: unknown;
};

export type IssueApp = { app: 'prospection' | 'notifuse' | 'crm' | 'academy' | 'analytics'; cible: string; ok: boolean; detail: string };

type Deps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  maintenant?: () => Date;
  /** Écrit une clé de metadata au Hub (par défaut : la base, fusion jsonb). */
  noter?: (tenantId: string, patch: Record<string, unknown>) => Promise<number | void>;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : 'erreur';
}

/** Retire l'espace d'une app à espace par organisation (CRM, Academy, Analytics) : `DELETE /api/tenants/:id`. */
async function supprimerEspace(app: 'crm' | 'academy' | 'analytics', hubTenantId: string, deps: Deps): Promise<{ ok: boolean; detail: string }> {
  const config = resolveAppConfig(app, deps.env ?? process.env);
  if (!config) return { ok: false, detail: `${app}_not_configured` };
  const cible = `${config.apiUrl}/api/tenants/${encodeURIComponent(hubTenantId)}`;
  const res = await (deps.fetchImpl ?? fetch)(cible, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...entetesSignature({ secret: config.hubSecret, methode: 'DELETE', url: cible, corps: '', app, maintenant: (deps.maintenant ?? (() => new Date()))().getTime() }),
    },
    signal: AbortSignal.timeout(90_000),
  });
  // 404 : l'espace n'existe pas (ou plus) : rien à retirer. Le mode rendu (Analytics : purge | conserve) est gardé dans le détail.
  const mode = res.ok ? ((await res.json().catch(() => null)) as { mode?: unknown } | null)?.mode : undefined;
  return { ok: res.ok || res.status === 404, detail: `http_${res.status}${typeof mode === 'string' ? ` ${mode.slice(0, 20)}` : ''}` };
}

/** Pose l'état « supprimé chez Prospection » sur chaque tenant qui y était provisionné. Une note ratée ne défait pas la suppression : elle est dite. */
async function noterSupprime(tenants: TenantADeprovisionner[], le: Date, purge: Date | null, deps: Deps): Promise<string> {
  const noter = deps.noter ?? ((id: string, patch: Record<string, unknown>) => fusionnerMetadata(prisma, id, patch));
  const patch = { prospection_status: 'deleted', prospection_soft_deleted_at: le.toISOString(), prospection_soft_deleted_reason: 'admin_action', ...(purge ? { prospection_purge_eligible_at: purge.toISOString() } : {}) };
  // Chaque note dit ce que la base a changé : la réponse (et le journal d'audit) le montrent, sans relecture à part.
  const lignes = await Promise.all(tenants.filter((t) => t.prospectionProvisionedAt).map((t) => noter(t.id, patch).then((n) => (typeof n === 'number' ? n : 1), () => -1)));
  const notees = lignes.filter((n) => n > 0).length;
  const ratees = lignes.length - notees;
  return ratees ? ` ; état non noté au Hub sur ${ratees} tenant(s)` : ` ; état noté au Hub (${notees} tenant${notees > 1 ? 's' : ''})`;
}

export async function deprovisionnerCompte(
  compte: { email: string; tenants: TenantADeprovisionner[] },
  deps: Deps = {},
): Promise<IssueApp[]> {
  const env = deps.env ?? process.env;
  const maintenant = (deps.maintenant ?? (() => new Date()))();
  const issues: IssueApp[] = [];
  const test = estCompteDeTest(compte.email);

  if (compte.tenants.some((t) => t.prospectionProvisionedAt)) {
    const client = createProspectionClientFromEnv();
    if (!client) {
      issues.push({ app: 'prospection', cible: 'proprietaire', ok: false, detail: 'prospection_not_configured' });
    } else {
      const purge = new Date(maintenant.getTime() + (test ? 0 : GRACE_JOURS * 86_400_000));
      try {
        await client.softDeleteTenant(compte.email, { purgeEligibleAt: purge.toISOString(), reason: 'admin_action' });
        issues.push({ app: 'prospection', cible: 'proprietaire', ok: true, detail: `soft-delete, purge le ${purge.toISOString().slice(0, 10)}${await noterSupprime(compte.tenants, maintenant, purge, deps)}` });
      } catch (err) {
        // Tenant déjà absent chez Prospection : rien à retirer, et c'est bien « supprimé » pour le Hub.
        const absent = /404|tenant_not_found/.test(message(err));
        issues.push({ app: 'prospection', cible: 'proprietaire', ok: absent, detail: absent ? `absent${await noterSupprime(compte.tenants, maintenant, null, deps)}` : message(err) });
      }
    }
  }

  const slugs = compte.tenants.map((t) => t.notifuseWorkspaceSlug).filter((s): s is string => Boolean(s));
  if (slugs.length) {
    const apiUrl = env.NOTIFUSE_API_URL;
    const hubSecret = env.NOTIFUSE_HUB_API_SECRET;
    for (const slug of slugs) {
      if (!apiUrl || !hubSecret) {
        issues.push({ app: 'notifuse', cible: slug, ok: false, detail: 'notifuse_not_configured' });
        continue;
      }
      try {
        await new NotifuseClient({ apiUrl, hubSecret, fetchImpl: deps.fetchImpl }).deleteWorkspace(slug);
        issues.push({ app: 'notifuse', cible: slug, ok: true, detail: 'supprimé' });
      } catch (err) {
        const absent = /404|not.?found/i.test(message(err));
        issues.push({ app: 'notifuse', cible: slug, ok: absent, detail: absent ? 'absent' : message(err) });
      }
    }
  }

  for (const t of compte.tenants) {
    const meta = t.metadata && typeof t.metadata === 'object' ? (t.metadata as Record<string, unknown>) : {};
    for (const app of ['crm', 'academy', 'analytics'] as const) {
      // Analytics crée aussi l'organisation à la première entrée par le rebond, sans que le Hub la note (27/11 : un compte du cas 56
      // supprimé sans appel). Sa route est idempotente (404 = absent) : appelée pour chaque organisation dès qu'Analytics est configuré.
      const toujours = app === 'analytics' && resolveAppConfig('analytics', env) !== null;
      if (!meta[app] && !toujours) continue;
      try {
        const r = await supprimerEspace(app, t.id, deps);
        issues.push({ app, cible: t.id, ...r });
      } catch (err) {
        issues.push({ app, cible: t.id, ok: false, detail: message(err) });
      }
    }
  }
  return issues;
}

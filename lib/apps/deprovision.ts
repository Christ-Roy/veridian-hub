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
 * - Rybbit : rien ici. Le signal « supprimé » coupe déjà l'accès, et Rybbit garde sites et rapports
 *   par conception (`hubUsers.ts`).
 * Chaque issue est rendue : un échec ne bloque pas la suppression au Hub, `hub reconcile` le voit.
 */
import { createHmac } from 'node:crypto';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { NotifuseClient } from '@/lib/notifuse/client';
import { createProspectionClientFromEnv } from '@/lib/prospection/client';

export const GRACE_JOURS = 90;
const COMPTE_DE_TEST = /^e2e-sso-[a-z0-9-]+@veridian\.site$/;

export type TenantADeprovisionner = {
  id: string;
  notifuseWorkspaceSlug: string | null;
  prospectionProvisionedAt: Date | null;
  metadata: unknown;
};

export type IssueApp = { app: 'prospection' | 'notifuse' | 'crm'; cible: string; ok: boolean; detail: string };

type Deps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  maintenant?: () => Date;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : 'erreur';
}

async function supprimerEspaceCrm(hubTenantId: string, deps: Deps): Promise<{ ok: boolean; detail: string }> {
  const config = resolveAppConfig('crm', deps.env ?? process.env);
  if (!config) return { ok: false, detail: 'crm_not_configured' };
  const ts = String((deps.maintenant ?? (() => new Date()))().getTime());
  const res = await (deps.fetchImpl ?? fetch)(`${config.apiUrl}/api/tenants/${encodeURIComponent(hubTenantId)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Veridian-Timestamp': ts,
      'X-Veridian-Hub-Signature': createHmac('sha256', config.hubSecret).update(`${ts}.`).digest('hex'),
    },
    signal: AbortSignal.timeout(90_000),
  });
  // 404 : l'espace n'existe pas (ou plus) : rien à retirer.
  return { ok: res.ok || res.status === 404, detail: `http_${res.status}` };
}

export async function deprovisionnerCompte(
  compte: { email: string; tenants: TenantADeprovisionner[] },
  deps: Deps = {},
): Promise<IssueApp[]> {
  const env = deps.env ?? process.env;
  const maintenant = (deps.maintenant ?? (() => new Date()))();
  const issues: IssueApp[] = [];
  const test = COMPTE_DE_TEST.test(compte.email.toLowerCase());

  if (compte.tenants.some((t) => t.prospectionProvisionedAt)) {
    const client = createProspectionClientFromEnv();
    if (!client) {
      issues.push({ app: 'prospection', cible: 'proprietaire', ok: false, detail: 'prospection_not_configured' });
    } else {
      const purge = new Date(maintenant.getTime() + (test ? 0 : GRACE_JOURS * 86_400_000));
      try {
        await client.softDeleteTenant(compte.email, { purgeEligibleAt: purge.toISOString(), reason: 'admin_action' });
        issues.push({ app: 'prospection', cible: 'proprietaire', ok: true, detail: `soft-delete, purge le ${purge.toISOString().slice(0, 10)}` });
      } catch (err) {
        // Tenant déjà absent chez Prospection : rien à retirer.
        const absent = /404|tenant_not_found/.test(message(err));
        issues.push({ app: 'prospection', cible: 'proprietaire', ok: absent, detail: absent ? 'absent' : message(err) });
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
    if (!meta.crm) continue;
    try {
      const r = await supprimerEspaceCrm(t.id, deps);
      issues.push({ app: 'crm', cible: t.id, ...r });
    } catch (err) {
      issues.push({ app: 'crm', cible: t.id, ok: false, detail: message(err) });
    }
  }
  return issues;
}

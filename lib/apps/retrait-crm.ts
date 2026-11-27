/**
 * Fusible du retrait d'un utilisateur côté CRM (VER-203, 23/11).
 *
 * `users/sync { deleted: true }` laissait dans Twenty la fiche de membre (workspaceMember) d'un utilisateur sans son
 * appartenance : l'espace ne chargeait plus pour les autres membres (mesuré sur staging, 6 fiches). Le CRM corrige à la
 * source ; tant que le correctif n'est pas servi, le Hub ne propage le retrait que s'il est sûr que la personne ne
 * reste dans AUCUN espace vivant du CRM. Sinon : retrait EN ATTENTE, sessions coupées (revoke_sessions, sans toucher
 * à l'appartenance), trace d'audit `crm.retrait.attente` et alerte. L'accès reste coupé : le Hub, seule entrée, ne
 * délivre plus de lien à un compte supprimé.
 *
 * Fermé par défaut : découverte illisible, en erreur ou ambiguë = retenu. Levée : `CRM_RETRAIT_FUSIBLE=0` dans le job
 * (dès que le CRM annonce son correctif en prod), puis `hub crm-retraits` rejoue les retraits en attente.
 */
import { enteteGet, readAppSecret, readAppUrl } from '@/lib/sync/discovery';

const DELAI_MS = 5_000;

export type VerdictRetrait =
  | { propager: true; raison: 'absent_du_crm' | 'aucun_espace' }
  | { propager: false; raison: 'espace_vivant' | 'decouverte_impossible'; espaces: number };

export const fusibleCrmActif = (env: NodeJS.ProcessEnv = process.env): boolean => env.CRM_RETRAIT_FUSIBLE !== '0';

type UtilisateurCrm = { hub_user_id?: string | null; email?: string | null };
type Deps = { fetchImpl?: typeof fetch; timeoutMs?: number };

/** GET signé du CRM ; null pour tout ce qui n'est pas un 200 avec un JSON lisible. */
async function lire(chemin: string, deps: Deps): Promise<unknown> {
  const url = readAppUrl('crm');
  const secret = readAppSecret('crm');
  if (!url || !secret) return null;
  const cible = `${url}${chemin}`;
  const r = await (deps.fetchImpl ?? fetch)(cible, {
    headers: enteteGet('crm', secret, cible),
    signal: AbortSignal.timeout(deps.timeoutMs ?? DELAI_MS),
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return (await r.json().catch(() => null)) as unknown;
}

/** Peut-on propager au CRM le retrait de ce compte sans risquer un espace partagé ? */
export async function verdictRetraitCrm(hubUserId: string, deps: Deps = {}): Promise<VerdictRetrait> {
  const inconnu = { propager: false, raison: 'decouverte_impossible', espaces: 0 } as const;
  // L'adresse du CRM peut différer de celle du Hub : on cherche par hub_user_id, puis par l'adresse que Twenty rend.
  const liste = (await lire('/api/hub/users', deps)) as { users?: unknown } | null;
  if (!liste || !Array.isArray(liste.users)) return inconnu;
  const membre = (liste.users as UtilisateurCrm[]).find((u) => u?.hub_user_id === hubUserId);
  if (!membre) return { propager: true, raison: 'absent_du_crm' };
  if (typeof membre.email !== 'string' || !membre.email) return inconnu;

  const corps = (await lire(`/api/users/by-email?email=${encodeURIComponent(membre.email)}`, deps)) as { found?: unknown; workspaces?: unknown } | null;
  if (!corps) return inconnu;
  if (corps.found === false) return { propager: true, raison: 'aucun_espace' };
  if (!Array.isArray(corps.workspaces)) return inconnu;
  return corps.workspaces.length === 0
    ? { propager: true, raison: 'aucun_espace' }
    : { propager: false, raison: 'espace_vivant', espaces: corps.workspaces.length };
}

/** Trace et alerte d'un retrait retenu. Identifiants seulement, jamais d'adresse. Ne lève jamais. */
export async function noterRetraitRetenu(hubUserId: string, v: Extract<VerdictRetrait, { propager: false }>): Promise<void> {
  console.warn(JSON.stringify({ tag: '[crm-retrait][attente]', level: 'warn', hub_user_id: hubUserId, raison: v.raison, espaces: v.espaces, ts: new Date().toISOString() }));
  try {
    const [{ prisma }, { writeAuditLog }, { sendTelegramAlert }] = await Promise.all([
      import('@/lib/prisma'),
      import('@/lib/admin/audit-log'),
      import('@/lib/notifications/telegram'),
    ]);
    await writeAuditLog(prisma, {
      action: 'crm.retrait.attente',
      actor: 'hub:fusible-crm',
      targetType: 'user',
      targetId: hubUserId,
      payload: { raison: v.raison, espaces: v.espaces },
    });
    await sendTelegramAlert(
      `Hub (avertissement) : retrait du CRM retenu pour ${hubUserId} (${v.raison}, ${v.espaces} espace(s) vivant(s)). Sessions coupées, accès refusé au Hub. À rejouer après le correctif du CRM : hub crm-retraits.`,
    );
  } catch (err) {
    console.error('[crm-retrait] trace ou alerte impossible', err instanceof Error ? err.message : 'erreur');
  }
}

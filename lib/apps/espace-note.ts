/**
 * Identifiant d'espace d'une app noté sur un tenant Hub, dans `metadata.<app>`. Une seule lecture pour tout le Hub (ouverture, présence,
 * appartenance, reconcile). `workspace_id` d'abord ; à défaut `external_tenant_id`, celui qu'écrivait `link-app` sans `workspace_id`
 * jusqu'au 26/11 : sans ce repli, une organisation Analytics reliée par `hub link` paraissait « sans espace » (défaut remonté par Analytics).
 * Le repli répare tous les liens existants à la lecture, sans écrire en base.
 */
export function idEspaceMeta(metadata: unknown, app: string): string | null {
  const m = (metadata ?? {}) as Record<string, { workspace_id?: unknown; external_tenant_id?: unknown } | undefined>;
  const n = m[app];
  if (!n || typeof n !== 'object') return null;
  const id = typeof n.workspace_id === 'string' && n.workspace_id ? n.workspace_id : n.external_tenant_id;
  return typeof id === 'string' && id ? id : null;
}

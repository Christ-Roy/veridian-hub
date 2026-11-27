/**
 * Un rebond refusé n'est jamais muet (08/11 : Robert renvoyé sans un mot sur Rybbit, aucune trace
 * au Hub). Chaque refus laisse une ligne `[bounce][refus]` (app, code, hub_user_id, jamais
 * l'adresse) et l'utilisateur lit pourquoi sur `/auth/bounce/error`.
 */

/** Codes qui disent quelque chose de l'identité ou de l'accès, pas de l'infrastructure : la page les explique. */
export const REFUS_IDENTITE = ['user_not_in_app', 'hub_user_conflict', 'email_not_proven', 'workspace_suspended', 'organisation_fournisseur'] as const;
export type RefusIdentite = (typeof REFUS_IDENTITE)[number];

export function journaliserRefus(r: {
  app: string;
  code: string;
  hubUserId: string | null;
  httpStatus?: number;
}): void {
  const identite = (REFUS_IDENTITE as readonly string[]).includes(r.code);
  const ligne = JSON.stringify({
    tag: '[bounce][refus]',
    level: identite ? 'warn' : 'error',
    msg: 'complete: bounce refused',
    app: r.app,
    code: r.code,
    hub_user_id: r.hubUserId,
    http_status: r.httpStatus ?? null,
    ts: new Date().toISOString(),
  });
  if (identite) console.warn(ligne);
  else console.error(ligne);
}

/**
 * Un rebond réussi, pour toutes les apps (VER-251, 24/11) : sans lui, aucun lien émis chez une app ne se recoupe avec une demande du
 * Hub. Jamais l'adresse, jamais le lien (il ouvre une session).
 */
export function journaliserReussite(r: { app: string; code: 'ok' | 'premiere_ouverture'; hubUserId: string }): void {
  console.info(JSON.stringify({ tag: '[bounce][reussi]', level: 'info', msg: 'complete: bounce done', app: r.app, code: r.code, hub_user_id: r.hubUserId, ts: new Date().toISOString() }));
}

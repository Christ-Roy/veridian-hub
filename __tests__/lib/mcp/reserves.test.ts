// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { familleReservee, reserveAuHub } from '@/lib/mcp/reserves';

const ecrit = (local: string, app = 'twenty') => ({ app, local, annotations: { readOnlyHint: false, destructiveHint: false } });
const lit = (local: string) => ({ local, annotations: { readOnlyHint: true, destructiveHint: false } });

describe('familleReservee', () => {
  it('membres, rôles, clés, webhooks, apps, réglages : réservés, dans les deux langues', () => {
    for (const n of ['add_member', 'delete_user', 'update_one_workspace_member', 'assign_role_to_workspace_member', 'invite_membre']) expect(familleReservee(ecrit(n)), n).toBe('personnes');
    for (const n of ['create_role', 'upsert_object_permissions', 'upsert_row_level_permission_rules', 'create_webhook', 'delete_webhook', 'install_app', 'creer_cle_api', 'revoquer_cle_api', 'accorder_acces_avance', 'update_site_config', 'create_team', 'delete_site', 'regler_espace', 'preparer_espace', 'updateWorkspaceSettings']) expect(familleReservee(ecrit(n)), n).toBe('administration');
  });
  it('le travail sur les données reste ouvert ; une lecture n\'est jamais réservée', () => {
    for (const n of ['create_many_people', 'update_one_company', 'delete_many_tasks', 'contacts_import', 'lists_create', 'extraire_segment', 'creer_segment', 'epingler', 'create_complete_workflow', 'create_view', 'publier_module', 'app_envoyer_au_crm', 'segment_rebuild', 'transactional_send', 'create_goal', 'create_funnel']) expect(familleReservee(ecrit(n)), n).toBeNull();
    for (const n of ['list_roles', 'find_many_workspace_members', 'list_webhooks', 'lister_cles_api', 'list_sites', 'list_available_apps']) expect(familleReservee(lit(n)), n).toBeNull();
  });
});

describe('reserveAuHub', () => {
  it('Analytics : un utilisateur ne se change qu\'au Hub, même en appel direct ; le reste d\'Analytics, et les autres apps, non', () => {
    for (const n of ['add_member', 'delete_user', 'remove_member', 'update_member_site_access']) expect(reserveAuHub(ecrit(n, 'analytics')), n).toBe(true);
    for (const n of ['update_site_config', 'create_goal', 'delete_site']) expect(reserveAuHub(ecrit(n, 'analytics')), n).toBe(false);
    expect(reserveAuHub(ecrit('update_one_workspace_member', 'twenty'))).toBe(false);
    expect(reserveAuHub({ ...lit('list_members'), app: 'analytics' })).toBe(false);
  });
});

/**
 * Le code des apps, quand il est à côté (poste de travail) : tout outil qui écrit et parle de personnes, de clés ou de webhooks doit tomber
 * dans la famille réservée. Une app qui en ajoute un sous un mot neuf fait échouer ce test ici, pas chez un client.
 */
const SOURCES: [string, string, RegExp][] = [
  ['veridian-analytics-rybbit', 'server/src/mcp/tools', /registerTool\(\s*"([a-z_]+)"/g],
  ['veridian-prospection', 'src/atlas/outils-mcp.ts', /^ {4}name: "([a-z_]+)"/gm],
  ['notifuse-veridian', 'internal/veridian/mcp', /\{Name: "([a-z_]+)"/g],
];
const SUSPECT = /user|member|membre|utilisateur|role|permission|webhook|cle_api|api_key|_acces|_access|token|settings|config|reglage|regler_/;
const LECTURE = /^(list|get|find|lister|lire|mes|search|chercher)|_list$|_get$/;
describe.each(SOURCES)('outils réels de %s', (depot, chemin, motif) => {
  const racine = path.resolve(process.cwd(), '..', depot);
  it.skipIf(!existsSync(racine))('aucun outil sensible hors de la famille réservée', () => {
    const code = execFileSync('git', ['-C', racine, 'grep', '-h', '', 'HEAD', '--', chemin], { encoding: 'utf8', maxBuffer: 64e6 });
    const noms = Array.from(code.matchAll(motif)).map((m) => m[1]);
    expect(noms.length, 'le relevé voit les outils').toBeGreaterThan(15);
    const oublies = noms.filter((n) => SUSPECT.test(n) && !LECTURE.test(n) && !familleReservee(ecrit(n)));
    expect(oublies).toEqual([]);
  });
});

/**
 * Client de l'API admin du Hub (mêmes routes que le CLI `hub`).
 * Le secret vient de l'environnement (ADMIN_SECRET) ou de ~/credentials/.all-creds.env,
 * lu à l'exécution : jamais écrit dans le dépôt ni affiché.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HUB_URL } from './cibles';
import { NonAbouti } from './etat';

let secret: string | null = null;

function lireSecret(): string {
  if (secret) return secret;
  if (process.env.ADMIN_SECRET) return (secret = process.env.ADMIN_SECRET);
  try {
    const txt = readFileSync(path.join(os.homedir(), 'credentials', '.all-creds.env'), 'utf8');
    for (const l of txt.split('\n')) {
      const m = l.match(/^\s*ADMIN_SECRET\s*=\s*(.*)$/);
      if (m) return (secret = m[1].trim().replace(/^['"]|['"]$/g, ''));
    }
  } catch {
    /* tombe sur NonAbouti ci-dessous */
  }
  throw new NonAbouti('secret admin du Hub introuvable (ADMIN_SECRET ou ~/credentials/.all-creds.env)');
}

export type Reponse<T = any> = { status: number; json: T };

/** L'API admin plafonne les appels : on attend le délai annoncé au lieu de conclure à tort. */
export async function admin<T = any>(
  methode: 'GET' | 'POST' | 'DELETE',
  route: string,
  corps?: unknown,
): Promise<Reponse<T>> {
  for (let essai = 0; ; essai++) {
    const { reponse, attente } = await appelAdmin<T>(methode, route, corps);
    if (reponse.status !== 429 || essai >= 4) return reponse;
    await new Promise((r) => setTimeout(r, attente));
  }
}

async function appelAdmin<T>(
  methode: 'GET' | 'POST' | 'DELETE',
  route: string,
  corps?: unknown,
): Promise<{ reponse: Reponse<T>; attente: number }> {
  let res: Response;
  try {
    res = await fetch(`${HUB_URL}/api/admin/${route}`, {
      method: methode,
      headers: {
        'x-admin-secret': lireSecret(),
        'content-type': 'application/json',
        'user-agent': 'Veridian-Systeme-SSO/1.0',
      },
      body: corps === undefined ? undefined : JSON.stringify(corps),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    throw new NonAbouti(`Hub injoignable (${route}) : ${(e as Error).message}`);
  }
  const txt = await res.text();
  let json: any = {};
  try {
    json = txt ? JSON.parse(txt) : {};
  } catch {
    json = { non_json: txt.slice(0, 200) };
  }
  const annonce = Number(res.headers.get('retry-after'));
  return {
    reponse: { status: res.status, json },
    attente: (Number.isFinite(annonce) && annonce > 0 ? annonce + 1 : 30) * 1000,
  };
}

/** Appel admin qui doit réussir, sinon NON ABOUTI (ce n'est pas l'objet testé). */
export async function adminOk<T = any>(
  methode: 'GET' | 'POST' | 'DELETE',
  route: string,
  corps?: unknown,
): Promise<T> {
  const r = await admin<T>(methode, route, corps);
  if (r.status >= 300) {
    throw new NonAbouti(`API admin ${methode} ${route} → HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  }
  return r.json;
}

export const usersCreate = (email: string, name: string) =>
  adminOk('POST', 'users/create', { email, name });
export const invite = (email: string, apps: string[], invitedBy: string) =>
  adminOk<{ invite_url: string }>('POST', 'onboarding/invite', {
    email,
    apps,
    sendEmail: false,
    invitedBy,
  });
export const impersonate = (email: string) =>
  adminOk<{ links: { hub: string; prospection: string | null; notifuse: string | null } }>(
    'POST',
    'impersonate',
    { email },
  );
export const lookup = (email: string) => admin('POST', 'users-lookup', { email });
export const planHub = (tenantId: string, app: 'prospection' | 'notifuse', plan: string) =>
  adminOk('POST', `tenants/${tenantId}/plan`, { app, plan, reason: 'TEST SYSTEME SSO' });
export const statutNotifuse = (tenantId: string) =>
  adminOk<{ plan: string; status: string }>(
    'GET',
    `notifuse/status?tenantId=${encodeURIComponent(tenantId)}`,
  );
export const identite = (email: string, changement: { new_email?: string; name?: string }) =>
  adminOk<{ hub_user_id: string; email: string; name: string; push: Record<string, string> }>(
    'POST',
    'users/identity',
    { email, ...changement },
  );
export const reconcile = () => adminOk('POST', 'reconcile-trigger');
export const listTenants = () => adminOk<{ tenants: any[] }>('GET', 'list-tenants');
export const supprimerTenantHub = (email: string) =>
  admin('DELETE', 'delete-tenant', { email, confirm: true });
export const supprimerNotifuse = (tenantId: string) =>
  admin('DELETE', 'notifuse/delete', { tenantId, confirm: true });

/**
 * Rybbit ne crée aucun compte depuis le Hub (contrat §6bis.8.3 : le rebond répond
 * `user_not_in_app` tant que le compte n'existe pas). On passe par le script de la session
 * Rybbit, qui refuse toute adresse hors e2e-sso-*@veridian.site et borne le compte au site de test.
 */
const SCRIPT_RYBBIT =
  process.env.RYBBIT_COMPTE_E2E || path.join(os.homedir(), '.claude/skills/rybbit/scripts/compte-e2e-rybbit.sh');

export function rybbitCompte(action: 'creer' | 'supprimer', email: string) {
  if (!existsSync(SCRIPT_RYBBIT)) {
    throw new NonAbouti(`script de compte Rybbit introuvable (${SCRIPT_RYBBIT}, ou RYBBIT_COMPTE_E2E)`);
  }
  try {
    execFileSync(SCRIPT_RYBBIT, [action, email], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    throw new NonAbouti(`compte Rybbit ${action} ${email} : sortie ${err.status} ${String(err.stderr ?? '').slice(0, 160)}`);
  }
}

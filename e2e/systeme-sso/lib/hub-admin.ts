/**
 * Client de l'API admin du Hub (mêmes routes que le CLI `hub`).
 * Le secret vient de l'environnement (ADMIN_SECRET) ou de ~/credentials/.all-creds.env,
 * lu à l'exécution : jamais écrit dans le dépôt ni affiché.
 */
import { readFileSync } from 'node:fs';
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

export async function admin<T = any>(
  methode: 'GET' | 'POST' | 'DELETE',
  route: string,
  corps?: unknown,
): Promise<Reponse<T>> {
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
  return { status: res.status, json };
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
export const reconcile = () => adminOk('POST', 'reconcile-trigger');
export const listTenants = () => adminOk<{ tenants: any[] }>('GET', 'list-tenants');
export const supprimerTenantHub = (email: string) =>
  admin('DELETE', 'delete-tenant', { email, confirm: true });
export const supprimerNotifuse = (tenantId: string) =>
  admin('DELETE', 'notifuse/delete', { tenantId, confirm: true });

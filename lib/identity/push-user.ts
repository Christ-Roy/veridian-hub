/**
 * Pousse une modification d'utilisateur du Hub vers les apps (CONTRAT-HUB §3.8).
 *
 *     POST <app>/api/hub/users/sync   (HMAC §6.1)
 *     { hub_user_id, name?, email?, deleted? }
 *
 * Best-effort : un échec ne bloque jamais le Hub (§1.4), l'écart reste visible dans
 * `hub reconcile` (`lib/sync/identity-audit.ts`), qui sert de rattrapage.
 *
 * Une adresse non prouvée n'est jamais poussée : le caller omet `email`, et le push
 * repart à la preuve. Sinon, changer son email au Hub suffirait à détourner la
 * connexion par email des apps.
 */

import { createHmac } from 'node:crypto';

import { configuredSyncApps, readAppSecret, readAppUrl } from '@/lib/sync/discovery';
import type { SyncApp } from '@/lib/sync/types';

const TIMEOUT_MS = 5_000;

export type UserPush = {
  hubUserId: string;
  name?: string | null;
  email?: string;
  deleted?: boolean;
};

export type PushOutcome = 'ok' | 'not_in_app' | 'endpoint_missing' | 'failed' | 'not_configured';

async function pushToApp(app: SyncApp, push: UserPush, fetchImpl: typeof fetch): Promise<PushOutcome> {
  const url = readAppUrl(app);
  const secret = readAppSecret(app);
  if (!url || !secret) return 'not_configured';

  const body = JSON.stringify({
    hub_user_id: push.hubUserId,
    ...(push.name !== undefined ? { name: push.name } : {}),
    ...(push.email !== undefined ? { email: push.email } : {}),
    ...(push.deleted ? { deleted: true } : {}),
  });
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  try {
    const res = await fetchImpl(`${url}/api/hub/users/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Veridian-Timestamp': timestamp,
        'X-Veridian-Hub-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return 'ok';
    if (res.status === 405 || res.status === 501) return 'endpoint_missing';
    if (res.status === 404) {
      const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
      return parsed?.error === 'user_not_in_app' ? 'not_in_app' : 'endpoint_missing';
    }
    return 'failed';
  } catch {
    return 'failed';
  }
}

export async function pushUserToApps(
  push: UserPush,
  opts: { fetchImpl?: typeof fetch; apps?: readonly SyncApp[] } = {},
): Promise<Partial<Record<SyncApp, PushOutcome>>> {
  const apps = opts.apps ?? configuredSyncApps();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const outcomes = await Promise.all(apps.map((app) => pushToApp(app, push, fetchImpl)));
  const result = Object.fromEntries(apps.map((app, i) => [app, outcomes[i]])) as Partial<
    Record<SyncApp, PushOutcome>
  >;
  console.log(
    JSON.stringify({
      tag: '[identity-push]',
      level: outcomes.includes('failed') ? 'warn' : 'info',
      hub_user_id: push.hubUserId,
      fields: Object.keys(push).filter((k) => k !== 'hubUserId'),
      result,
      ts: new Date().toISOString(),
    }),
  );
  return result;
}

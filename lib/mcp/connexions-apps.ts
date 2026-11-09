/**
 * Lecture, par une app, des assistants IA reliés à un compte (Atlas affiche « Claude connecté » avant
 * même le premier appel d'outil). Signée comme les autres échanges Hub ↔ app (§6.1) : HMAC sur
 * `${timestamp}.` (requête GET, corps vide), avec le secret Hub de l'app. Lecture seule.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';

const DERIVE_MS = 5 * 60_000;
const APPS = ['prospection', 'notifuse', 'analytics', 'crm'] as const;

function egal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** L'app qui a signé, ou null (signature fausse, horodatage hors fenêtre, en-têtes absents). */
export function appSignataire(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
  maintenant: number = Date.now(),
): string | null {
  const ts = headers.get('x-veridian-timestamp') ?? '';
  const sig = (headers.get('x-veridian-hub-signature') ?? '').toLowerCase();
  if (!/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(maintenant - tsMs) > DERIVE_MS) return null;
  for (const app of APPS) {
    const config = resolveAppConfig(app, env);
    if (!config?.hubSecret) continue;
    if (egal(createHmac('sha256', config.hubSecret).update(`${ts}.`).digest('hex'), sig)) return app;
  }
  return null;
}

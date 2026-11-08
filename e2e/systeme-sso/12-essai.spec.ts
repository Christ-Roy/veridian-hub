/**
 * La machine d'états de l'essai réagit au vrai signal (08/11 : elle n'avait jamais tourné, Notifuse
 * n'envoyait rien, et le slug qu'il enverra n'aurait pas été reconnu). Le signal part comme Notifuse
 * l'enverra (v1.4, Bearer, `tenant_id` = slug de son espace) ; la ligne naît `eligible` sur l'id du
 * tenant Hub ; reculée de 49 h, le tick l'active ; Notifuse reçoit `pro` par son slug, et le mail
 * « essai démarré » arrive dans une vraie boîte (groupe Lark `e2e-sso-essai@veridian.site`).
 * Le tick envoie aussi une alerte Telegram à Robert : test libellé. Épreuve : `SSO_SABOTAGE=signal`.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from '@playwright/test';

import { attendreMail } from './lib/boite';
import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { lookup, statutNotifuse } from './lib/hub-admin';
import { creerCompteProuve } from './lib/parcours';

const ADRESSE = 'e2e-sso-essai@veridian.site';
const SCRIPT = process.env.ESSAI_E2E || path.join(os.homedir(), '.claude/skills/hub-admin/scripts/essai-e2e.sh');

function essai(...args: string[]): string {
  try {
    return execFileSync(SCRIPT, args, { encoding: 'utf8', timeout: 360_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    throw new NonAbouti(`essai-e2e ${args[0]} : sortie ${err.status} ${String(err.stderr ?? '').slice(0, 160)}`);
  }
}

function jetonWebhook(): string {
  const txt = readFileSync(path.join(os.homedir(), 'credentials', '.all-creds.env'), 'utf8');
  const m = txt.match(/^\s*NOTIFUSE_WEBHOOK_TOKEN\s*=\s*(.*)$/m);
  if (!m) throw new NonAbouti('NOTIFUSE_WEBHOOK_TOKEN introuvable dans ~/credentials/.all-creds.env');
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

async function signal(slug: string, cle: string) {
  return fetch(`${HUB_URL}/api/webhooks/notifuse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jetonWebhook()}` },
    body: JSON.stringify({
      contract_version: '1.4',
      event: 'tenant.activity_threshold_reached',
      tenant_id: slug,
      data: { emails_sent_lifetime: 5, threshold: 5, reached_at: new Date().toISOString() },
      idempotency_key: cle,
      occurred_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(20_000),
  });
}

cas('notifuse', 'le signal d\'activité active l\'essai : eligible sur le tenant Hub, tick, plan pro chez Notifuse, mail reçu', async ({ browser }) => {
  const depuis = new Date();
  const E = await creerCompteProuve(browser, 'essai', ADRESSE);
  const slug = (await lookup(ADRESSE)).json?.tenants?.[0]?.notifuseWorkspaceSlug as string | undefined;
  if (!slug || !E.tenantId) throw new NonAbouti('compte de test sans espace Notifuse ni tenant');
  essai('retirer', ADRESSE); // départ propre
  try {
    if (process.env.SSO_SABOTAGE !== 'signal') {
      const cle = randomUUID();
      const r = await signal(slug, cle);
      expect(r.status, 'signal reçu par le Hub').toBe(200);
      expect((await signal(slug, cle)).status, 'rejeu de la même clé').toBe(200);
    }
    expect(essai('lire', ADRESSE), 'ligne eligible sur l\'id du tenant Hub (le slug est ramené)').toBe(`${E.tenantId} eligible`);
    essai('reculer', ADRESSE, '49');
    const tick = JSON.parse(essai('tick').split('\n')[0]) as { activated?: number; errors?: unknown[] };
    expect(tick.activated, `tick : ${JSON.stringify(tick).slice(0, 200)}`).toBeGreaterThanOrEqual(1);
    expect(essai('lire', ADRESSE), 'essai actif après le tick').toBe(`${E.tenantId} trial_active`);
    expect((await statutNotifuse(E.tenantId)).plan, 'Notifuse passé en pro par son slug').toBe('pro');
    const mail = await attendreMail(ADRESSE, 'essai Pro Veridian vient de démarrer', depuis);
    expect(mail, 'mail « essai démarré »').toContain('15');
    return `signal (slug ${slug}) → eligible sur ${E.tenantId} → tick → trial_active, Notifuse pro, mail reçu`;
  } finally {
    essai('retirer', ADRESSE);
  }
}, { timeout: 600_000 });

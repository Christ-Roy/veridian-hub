/**
 * Signature Standard Webhooks (Notifuse `message.received`) : `webhook-signature: v1,<base64 HMAC-SHA256("id.timestamp.corps")>`, clé = le
 * secret `whsec_<base64>` décodé. Fenêtre de 5 min comme la signature des apps ; le rejeu dans la fenêtre est arrêté par le dédoublonnage en base.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { FENETRE_MS } from '@/lib/delegation/jeton';

export type VerdictSignature = 'ok' | 'invalid_headers' | 'timestamp_expired' | 'invalid_signature';

export function verifierStandardWebhooks(secret: string, h: Headers, corps: string, now = Date.now()): VerdictSignature {
  const id = h.get('webhook-id') ?? '';
  const ts = h.get('webhook-timestamp') ?? '';
  const sig = h.get('webhook-signature') ?? '';
  if (!/^[\x21-\x7e]{1,128}$/.test(id) || !/^\d{9,13}$/.test(ts) || !sig) return 'invalid_headers';
  if (Math.abs(now - Number(ts) * 1000) > FENETRE_MS) return 'timestamp_expired';
  const cle = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const attendu = createHmac('sha256', cle).update(`${id}.${ts}.${corps}`).digest();
  // Toutes les signatures proposées sont comparées, sans sortir à la première : le temps ne dit pas laquelle a validé.
  const valides = sig.split(' ').map((s) => {
    const [v, b64] = s.split(',');
    const recu = v === 'v1' && b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
    return recu.length === attendu.length && timingSafeEqual(recu, attendu);
  });
  return valides.includes(true) ? 'ok' : 'invalid_signature';
}

/**
 * Signature Hub → app de la batterie : celle du Hub lui-même (`lib/hmac/signature-hub.ts`), jamais un HMAC refait à la main.
 * v2 vers les apps qui la vérifient, comme `HMAC_V2_APPS` du job visé (prod : les cinq ; staging : Mail). Pourquoi (27/11) : Academy refuse la v1
 * depuis `VERIDIAN_HMAC_REQUIRE_V2`, ce qui rendait NON ABOUTI tout cas qui l'appelait ; et chaque appel v1 de la batterie empêchait les autres apps de
 * fermer la v1 (« un jour sans v1 reçue »). Épreuve : `SSO_SIGNATURE_V1=1` signe en v1 ; un cas qui appelle Academy en prod doit alors échouer.
 */
import { entetesSignature } from '../../../lib/hmac/signature-hub';
import { HUB_URL } from './cibles';

const EN_V2 = () => (process.env.SSO_SIGNATURE_V1 === '1' ? '' : /staging/.test(HUB_URL) ? 'notifuse' : 'notifuse,crm,prospection,analytics,academy');

/** En-têtes signés pour UNE requête : `url` complète (chemin et query signés tels qu'envoyés), `corps` = les octets exacts envoyés. */
export function signatureVersApp(app: string, secret: string, methode: string, url: string, corps = ''): Record<string, string> {
  return entetesSignature({ secret, methode, url, corps, app, env: { ...process.env, HMAC_V2_APPS: EN_V2() } });
}

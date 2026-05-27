/**
 * Vault AES-256-GCM dédié au CRM Hub (Twenty fork API keys + passwords).
 *
 * Pourquoi un vault dédié plutôt qu'un helper crypto générique :
 *  - On stocke des secrets long-lived (Bearer Twenty 1 an + password
 *    régénération magic link) — séparer la clé permet une rotation
 *    indépendante du reste de l'app (Notifuse, Prospection, etc.)
 *  - L'API publique est volontairement minimaliste (encrypt/decrypt
 *    strings → strings base64) pour éviter les pièges d'IV mutualisé
 *    ou de format binaire mixé avec d'autres consumers
 *
 * Format payload base64 : `<iv (12B)>.<authTag (16B)>.<ciphertext (var)>`
 * (séparateur `.` car base64url ne le contient pas).
 *
 * Clé : ENV `CRM_VAULT_KEY` (32 bytes encodés base64 ou base64url, soit
 * 43-44 chars). Génération : `openssl rand -base64 32`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM standard
const KEY_LEN = 32; // AES-256
const SEP = '.';

/**
 * Charge la clé depuis ENV. Throw clair si manquante ou mal formée — on ne
 * veut JAMAIS chiffrer avec un fallback faible ou silencieux. Le seul
 * usage de ce module est admin (création de tenant) : une erreur 500 au
 * boot est préférable à un secret stocké avec une clé devinée.
 */
function loadKey(): Buffer {
  const raw = process.env.CRM_VAULT_KEY;
  if (!raw) {
    throw new Error('CRM_VAULT_KEY env var missing — required for /api/admin/crm/*');
  }
  // Accepte base64 et base64url (Node 18+ supporte 'base64url' nativement).
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CRM_VAULT_KEY must be valid base64');
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `CRM_VAULT_KEY must decode to exactly ${KEY_LEN} bytes (got ${key.length}). ` +
        'Generate with: openssl rand -base64 32',
    );
  }
  return key;
}

/**
 * Chiffre une string UTF-8 → payload `iv.tag.ciphertext` (base64 segments).
 *
 * @throws Error si CRM_VAULT_KEY est absente ou invalide.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptSecret: plaintext must be a string');
  }
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(SEP);
}

/**
 * Déchiffre un payload produit par `encryptSecret`. Throw si la clé ou
 * l'authTag ne correspondent pas (intégrité GCM). Throw aussi si le format
 * est cassé (corruption DB / payload tronqué).
 */
export function decryptSecret(payload: string): string {
  if (typeof payload !== 'string') {
    throw new Error('decryptSecret: payload must be a string');
  }
  const parts = payload.split(SEP);
  if (parts.length !== 3) {
    throw new Error('decryptSecret: invalid payload format (expected iv.tag.ciphertext)');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN) {
    throw new Error(`decryptSecret: invalid IV length (${iv.length})`);
  }
  if (tag.length !== TAG_LEN) {
    throw new Error(`decryptSecret: invalid tag length (${tag.length})`);
  }
  const key = loadKey();
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Tests pour lib/crm/vault.ts (AES-256-GCM).
 *
 * Couvre :
 *  - encrypt → decrypt roundtrip avec divers payloads (vide, ASCII, UTF-8, long)
 *  - chaque encrypt produit un IV différent (probabiliste, mais 12B → collision ≈ 0)
 *  - decrypt rejette un payload tampered (authTag invalide)
 *  - decrypt rejette un format cassé
 *  - throw clair si CRM_VAULT_KEY absente / mauvaise longueur / mauvais base64
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { decryptSecret, encryptSecret } from '@/lib/crm/vault';

const ORIG_KEY = process.env.CRM_VAULT_KEY;
const VALID_KEY = randomBytes(32).toString('base64');

beforeEach(() => {
  process.env.CRM_VAULT_KEY = VALID_KEY;
});

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.CRM_VAULT_KEY;
  else process.env.CRM_VAULT_KEY = ORIG_KEY;
});

describe('lib/crm/vault — encryptSecret / decryptSecret roundtrip', () => {
  it('roundtrips ASCII text', () => {
    const plain = 'hello-twenty-bearer-jwt';
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('roundtrips UTF-8 with emojis', () => {
    const plain = 'café-é-ñ-😀-中文';
    const enc = encryptSecret(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('roundtrips empty string', () => {
    const enc = encryptSecret('');
    expect(decryptSecret(enc)).toBe('');
  });

  it('roundtrips long payload (typical JWT ~600 chars)', () => {
    const plain = 'a'.repeat(600);
    const enc = encryptSecret(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plain = 'same-input';
    const enc1 = encryptSecret(plain);
    const enc2 = encryptSecret(plain);
    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1)).toBe(plain);
    expect(decryptSecret(enc2)).toBe(plain);
  });

  it('payload format is iv.tag.ciphertext (3 base64 segments)', () => {
    const enc = encryptSecret('x');
    const parts = enc.split('.');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0], 'base64').length).toBe(12); // IV
    expect(Buffer.from(parts[1], 'base64').length).toBe(16); // tag
  });
});

describe('lib/crm/vault — integrity & validation', () => {
  it('decryptSecret throws when authTag is tampered', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split('.');
    // Flip last byte of the authTag
    const tagBytes = Buffer.from(parts[1], 'base64');
    tagBytes[tagBytes.length - 1] ^= 0xff;
    const tampered = [parts[0], tagBytes.toString('base64'), parts[2]].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('decryptSecret throws when ciphertext is tampered', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split('.');
    const ctBytes = Buffer.from(parts[2], 'base64');
    // Flip a bit only if there is at least 1 byte (empty plaintext = 0B ct)
    expect(ctBytes.length).toBeGreaterThan(0);
    ctBytes[0] ^= 0x01;
    const tampered = [parts[0], parts[1], ctBytes.toString('base64')].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('decryptSecret throws when format is broken (only 2 segments)', () => {
    expect(() => decryptSecret('only.two')).toThrow(/invalid payload format/);
  });

  it('decryptSecret throws when IV length is wrong', () => {
    const enc = encryptSecret('x');
    const parts = enc.split('.');
    const bogusIv = Buffer.alloc(10).toString('base64'); // 10B != 12B
    const broken = [bogusIv, parts[1], parts[2]].join('.');
    expect(() => decryptSecret(broken)).toThrow(/invalid IV length/);
  });

  it('decryptSecret throws when tag length is wrong', () => {
    const enc = encryptSecret('x');
    const parts = enc.split('.');
    const bogusTag = Buffer.alloc(8).toString('base64'); // 8B != 16B
    const broken = [parts[0], bogusTag, parts[2]].join('.');
    expect(() => decryptSecret(broken)).toThrow(/invalid tag length/);
  });

  it('throws when CRM_VAULT_KEY env var is missing', () => {
    // Produce a valid format payload first (while key is set), then nuke
    // the key — so we hit loadKey() in decryptSecret, not the format check.
    const wellFormed = encryptSecret('placeholder');
    delete process.env.CRM_VAULT_KEY;
    expect(() => encryptSecret('x')).toThrow(/CRM_VAULT_KEY env var missing/);
    expect(() => decryptSecret(wellFormed)).toThrow(/CRM_VAULT_KEY env var missing/);
  });

  it('throws when CRM_VAULT_KEY decodes to wrong length', () => {
    process.env.CRM_VAULT_KEY = Buffer.alloc(16).toString('base64'); // 16B, not 32B
    expect(() => encryptSecret('x')).toThrow(/must decode to exactly 32 bytes/);
  });

  it('decryptSecret with a different key throws (cross-tenant key isolation)', () => {
    const encWithKey1 = encryptSecret('cross-key-leak-test');
    process.env.CRM_VAULT_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSecret(encWithKey1)).toThrow();
  });
});

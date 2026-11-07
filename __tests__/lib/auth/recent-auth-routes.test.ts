/**
 * D12 : les actions à session qui engagent le compte ou la facturation exigent une preuve
 * récente. Garde statique : une route ajoutée plus tard sans la garde fait échouer ce test.
 * `checkout-from-app` n'est pas listée : appel HMAC serveur à serveur, sans session utilisateur.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = process.cwd();
const GARDEES: Array<[string, string]> = [
  ['app/api/billing/refill-leads/checkout/route.ts', 'PREUVE_FACTURATION_S'],
  ['app/api/auth/mfa/toggle/route.ts', 'PREUVE_COMPTE_S'],
  ['app/api/account/connected-providers/[provider]/route.ts', 'PREUVE_COMPTE_S'],
];

describe('preuve récente sur les routes sensibles (D12)', () => {
  it.each(GARDEES)('%s appelle denyUnlessRecentAuth(%s)', (fichier, constante) => {
    const src = readFileSync(resolve(ROOT, fichier), 'utf8');
    expect(src).toContain('denyUnlessRecentAuth(');
    expect(src).toContain(constante);
  });
});

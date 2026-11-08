/**
 * Toute route accessible à une session utilisateur et qui fabrique une session d'app
 * doit passer par la garde d'adresse prouvée. Le test supprime la classe de défaut :
 * une nouvelle route qui appelle un de ces producteurs sans garde le fait échouer.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PRODUCERS =
  /provisionTenant|provisionWorkspace|provisionNotifuse|provisionProspection|provisionTenantForApp|provisionAll|issueMagicLinkForApp|resolveNotifuseAutoLogin|regenerateMagicLink|createTenant\(|generateMagicLink|provisionUserServices|provisionUserTenant/;
const GUARD = /denyUnlessEmailProven/;

// Routes hors session utilisateur : auth propre (admin, cron, webhook HMAC) ou appelée
// par un système. L'admin reste tracé (impersonation comprise).
const OUT_OF_SCOPE = /^app\/api\/(admin\/(?!notifuse\/magic-link)|cron\/|webhooks\/|onboarding\/)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const routes = walk('app/api').filter((p) => p.endsWith('route.ts') && !OUT_OF_SCOPE.test(p));

describe('routes menant à une session d\'app', () => {
  it('la détection voit bien les routes connues (la mesure ne tourne pas à vide)', () => {
    const flagged = routes.filter((p) => PRODUCERS.test(readFileSync(p, 'utf8')));
    for (const known of [
      'app/api/prospection/regenerate-login/route.ts',
      'app/api/auth/bounce/complete/route.ts',
      'app/api/admin/notifuse/magic-link/route.ts',
    ]) {
      expect(flagged).toContain(known);
    }
  });

  it.each(routes.filter((p) => PRODUCERS.test(readFileSync(p, 'utf8'))))('%s est gardée', (path) => {
    expect(readFileSync(path, 'utf8')).toMatch(GUARD);
  });

  it('tenants/start et retry, qui provisionnent via utils/tenants, sont gardées', () => {
    for (const path of ['app/api/tenants/start/route.ts', 'app/api/tenants/retry/route.ts']) {
      expect(readFileSync(path, 'utf8')).toMatch(GUARD);
    }
  });
});

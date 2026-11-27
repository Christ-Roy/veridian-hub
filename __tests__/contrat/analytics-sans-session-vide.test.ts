import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 27/11 : 55 des 97 sessions de la vitrine n'avaient aucune page vue, que des `signup` et `app_started` émis par le Hub.
 * Garde : tout événement du Hub vers Analytics passe par `trackGoal` (identité de test filtrée, `anonymous_id` stable,
 * drapeau `session_serveur`). Un second émetteur vers `/api/track` contournerait ces trois protections.
 */
const racine = join(__dirname, '..', '..');
function fichiers(dir: string, out: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    if (['node_modules', '.next', '.claude', '__tests__'].includes(nom)) continue;
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) fichiers(p, out);
    else if (/\.(ts|tsx)$/.test(nom)) out.push(p);
  }
  return out;
}

describe('Analytics : aucune session vide ajoutée par le Hub', () => {
  it('seul lib/analytics/track-event.ts appelle /api/track', () => {
    const fautifs = [...fichiers(join(racine, 'app')), ...fichiers(join(racine, 'lib')), ...fichiers(join(racine, 'components'))]
      .filter((f) => !f.endsWith(join('lib', 'analytics', 'track-event.ts')))
      .filter((f) => /\/api\/track['"`]/.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
  });

  it('trackGoal filtre les identités de test et porte anonymous_id + session_serveur', () => {
    const src = readFileSync(join(racine, 'lib', 'analytics', 'track-event.ts'), 'utf8');
    expect(src).toMatch(/estIdentiteDeTestAnalytics\(userId\)/);
    expect(src).toMatch(/anonymous_id: input\.sessionId/);
    expect(src).toMatch(/session_serveur: '1'/);
  });
});

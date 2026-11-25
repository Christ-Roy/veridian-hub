// @vitest-environment node
/** Ce qui sort vers un service extérieur, contre un VRAI serveur (jetable) qui ment sur ses adresses, redirige, déborde ou traîne. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sortieMcp, sortieOAuth, tenirAdresse } from '@/lib/connecteurs/sortie';
import type { Connecteur } from '@/lib/connecteurs/registre';

import { ouvrirService } from '../../../e2e/systeme-sso/lib/service-jetable';

const D = { fetchImpl: fetch as never, enClair: true };
let s: Awaited<ReturnType<typeof ouvrirService>>;
let c: Connecteur;
beforeAll(async () => { s = await ouvrirService(); c = { cle: 'essai', nom: 'Essai', texte: '', mcpUrl: s.mcpUrl, oauth: s.hotes, outils: {} }; });
afterAll(() => s.fermer());
beforeEach(() => s.mentir(null));
const META = () => `${s.base}/.well-known/oauth-authorization-server`;

describe('tenirAdresse', () => {
  it.each([
    ['https://a.test/x', true], ['https://a.test:8443/x', false], ['http://a.test/x', false], ['https://b.test/x', false], ['https://u:p@a.test/x', false], ['https://a.test.evil.test/', false], ['https://a.test@evil.test/', false], ['https://[::1]/', false], ['https://127.0.0.1/', false],
  ])('%s : %s', (u, ok) => (ok ? expect(tenirAdresse(u, ['a.test']).host).toBe('a.test') : expect(() => tenirAdresse(u, ['a.test'])).toThrow()));
});
describe('sortieOAuth', () => {
  it('témoin : ses hôtes OAuth ; ni un autre hôte, ni le clair hors épreuve', async () => {
    expect((await sortieOAuth(c, D)(META())).status).toBe(200);
    await expect(sortieOAuth(c, D)('http://127.0.0.1:9/token')).rejects.toThrow('hote_inattendu');
    await expect(sortieOAuth(c)(META())).rejects.toThrow('adresse_refusee');
  });
  it('une redirection n\'est jamais suivie', async () => {
    s.mentir('redirige');
    await expect(sortieOAuth(c, D)(META())).rejects.toThrow('redirection');
    expect(s.vu.ailleurs).toBe(0);
  });
  it('réponse énorme : coupée ; muette, ou au goutte à goutte : la durée TOTALE est bornée', async () => {
    s.mentir('enorme');
    await expect(sortieOAuth(c, D)(META())).rejects.toThrow('reponse_trop_grosse');
    for (const x of ['lent', 'goutte'] as const) {
      s.mentir(x);
      const debut = Date.now();
      await expect(sortieOAuth(c, { ...D, delaiMs: 300 })(META())).rejects.toThrow();
      expect(Date.now() - debut, x).toBeLessThan(3_000);
    }
  });
});
describe('sortieMcp', () => {
  it('à l\'adresse exacte du service, nulle part ailleurs sur son hôte', async () => {
    expect((await sortieMcp(c, D)(s.mcpUrl, { method: 'POST', body: '{}' })).status).toBe(401);
    await expect(sortieMcp(c, D)(`${s.base}/token`)).rejects.toThrow('hote_inattendu');
  });
});
it('par la vraie sortie, une adresse privée n\'est jamais jointe, même si son nom est au registre', async () => {
  const local = { ...c, mcpUrl: 'https://localhost:9/mcp', oauth: { ...c.oauth, emetteur: 'https://localhost:9' } };
  await expect(sortieMcp(local)('https://localhost:9/mcp')).rejects.toThrow(/adresse_privee/);
  await expect(sortieOAuth(local)('https://localhost:9/x')).rejects.toThrow(/adresse_privee/);
});

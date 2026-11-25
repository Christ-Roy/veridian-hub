// @vitest-environment node
import { beforeEach, expect, it } from 'vitest';
import { decode } from 'next-auth/jwt';

import { cookieRetour, lireRetour, scellerRetour } from '@/lib/emprunt/retour';

beforeEach(() => { process.env.AUTH_SECRET = 'secret-de-test-assez-long-pour-chiffrer'; });
const r = { empruntId: 'e-1', session: 'jeton', org: null };

it('se rend à son emprunt seulement', async () => {
  const v = await scellerRetour(r);
  expect([await lireRetour(v, 'e-1'), await lireRetour(v, 'e-2'), await lireRetour(undefined, 'e-1'), await lireRetour('forge', 'e-1')]).toEqual([r, null, null, null]);
});
it('un autre secret ne l\'ouvre pas', async () => {
  const v = await scellerRetour(r);
  process.env.AUTH_SECRET = 'un-autre-secret-tout-aussi-long-que-lui';
  expect(await lireRetour(v, 'e-1')).toBeNull();
});
it('ce n\'est pas une session : le sel d\'une session ne le déchiffre pas', async () => {
  const v = await scellerRetour(r);
  for (const salt of ['__Secure-authjs.session-token', 'authjs.session-token']) await expect(decode({ token: v, salt, secret: process.env.AUTH_SECRET! })).rejects.toThrow();
});
it('cookie sécurisé en HTTPS', () => expect([cookieRetour(true), cookieRetour(false)]).toEqual(['__Secure-veridian-retour', 'veridian-retour']));

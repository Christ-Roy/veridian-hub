/**
 * Tests du helper de déconnexion client `signOutWithHintClear`.
 *
 * Contexte : le `signOut()` de next-auth ne supprime que le cookie session
 * Auth.js. Le hint cross-subdomain `veridian-session-hint` (TTL 30j, scope
 * .veridian.site) lui survivait → la landing veridian.site affichait un
 * utilisateur connecté après déconnexion.
 *
 * Le correctif de fond est serveur (le wrapper du POST /api/auth/signout
 * greffe le Set-Cookie de suppression). Ce helper est la bretelle côté
 * client. Ce qu'on verrouille ici :
 *  - la route de suppression est bien appelée, en POST
 *  - elle est appelée AVANT signOut (qui navigue et peut tuer une requête
 *    en vol)
 *  - les options (callbackUrl) sont transmises telles quelles
 *  - un échec réseau du clear ne bloque JAMAIS la déconnexion
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const signOutMock = vi.fn(async () => undefined);
vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

import {
  signOutWithHintClear,
  clearSessionHint,
  SESSION_HINT_CLEAR_ENDPOINT,
} from '@/lib/auth/sign-out-with-hint-clear';

/** Trace l'ordre des appels pour prouver que le clear précède le signOut. */
let callOrder: string[] = [];
const fetchMock = vi.fn(async () => {
  callOrder.push('fetch');
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});

beforeEach(() => {
  callOrder = [];
  fetchMock.mockClear();
  signOutMock.mockClear();
  signOutMock.mockImplementation(async () => {
    callOrder.push('signOut');
    return undefined;
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('clearSessionHint', () => {
  it('POST sur la route de suppression du hint', async () => {
    await clearSessionHint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SESSION_HINT_CLEAR_ENDPOINT);
    expect(url).toBe('/api/auth/session-hint/clear');
    expect(init.method).toBe('POST');
  });

  it("envoie les cookies (sans quoi le serveur n'a rien à supprimer)", async () => {
    await clearSessionHint();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
    // Une réponse mise en cache ne porterait pas le Set-Cookie de suppression.
    expect(init.cache).toBe('no-store');
  });

  it('avale les erreurs réseau (ne rejette jamais)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(clearSessionHint()).resolves.toBeUndefined();
  });
});

describe('signOutWithHintClear', () => {
  it('efface le hint PUIS déclenche le signOut Auth.js', async () => {
    await signOutWithHintClear({ callbackUrl: '/dashboard' });
    // L'ordre compte : signOut navigue, une requête en vol serait annulée.
    expect(callOrder).toEqual(['fetch', 'signOut']);
  });

  it('transmet les options à signOut (callbackUrl préservée)', async () => {
    await signOutWithHintClear({ callbackUrl: '/dashboard/settings' });
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/dashboard/settings' });
  });

  it('appelle signOut sans options quand aucune n\'est fournie', async () => {
    await signOutWithHintClear();
    expect(signOutMock).toHaveBeenCalledWith(undefined);
  });

  it('déconnecte quand même si le clear échoue (best-effort)', async () => {
    // Le hint n'est que du confort d'affichage — jamais un motif de retenir
    // un utilisateur qui veut se déconnecter. Le serveur clear de son côté.
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await signOutWithHintClear({ callbackUrl: '/' });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['signOut']);
  });

  it('déconnecte quand même si la route répond en erreur', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await signOutWithHintClear({ callbackUrl: '/' });
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});

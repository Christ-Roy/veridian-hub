// @vitest-environment node
import { NextResponse } from 'next/server';
import { expect, it } from 'vitest';

import { COOKIE_PAUSE, COOKIE_PORTE, PAUSE_DECONNEXION_S, PAUSE_ESSAI_S, pauserPorte, pauseSetCookie, porteValable, retenirPorte } from '@/lib/federation/porte';

it('porteValable : un nom de porte, jamais un chemin ni une adresse', () => expect(['asd', 'a', '../x', 'A', 'https://x', '', undefined].map(porteValable)).toEqual(['asd', 'a', null, null, null, null, null]));
it('COOKIE_PORTE : le nom seul, un an, HttpOnly, aucune valeur de session', () => {
  const r = NextResponse.json({});
  retenirPorte(r, 'asd', true);
  expect(r.headers.get('set-cookie')).toMatch(new RegExp(`${COOKIE_PORTE}=asd; Path=/;.*Max-Age=31536000;.*Secure; HttpOnly; SameSite=lax`, 'i'));
});
it('COOKIE_PAUSE : bornée, pour un essai comme pour une déconnexion', () => {
  const r = NextResponse.json({});
  pauserPorte(r, PAUSE_ESSAI_S, true);
  expect(r.headers.get('set-cookie')).toMatch(new RegExp(`${COOKIE_PAUSE}=1;.*Max-Age=120`, 'i'));
  expect(pauseSetCookie(PAUSE_DECONNEXION_S, true)).toBe(`${COOKIE_PAUSE}=1; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
});
it('PAUSE_DECONNEXION_S : plus longue que celle d\'un essai', () => expect(PAUSE_DECONNEXION_S).toBeGreaterThan(PAUSE_ESSAI_S));
it('retenirPorte : en clair seulement hors https', () => { const r = NextResponse.json({}); retenirPorte(r, 'x', false); expect(r.headers.get('set-cookie')).not.toMatch(/Secure/); });
it('pauserPorte et pauseSetCookie posent le même cookie', () => { const r = NextResponse.json({}); pauserPorte(r, 5, true); expect(r.headers.get('set-cookie')?.split('=')[0]).toBe(pauseSetCookie(5, true).split('=')[0]); });
it('COOKIE_PORTE et COOKIE_PAUSE : deux cookies', () => expect(COOKIE_PORTE).not.toBe(COOKIE_PAUSE));
it('PAUSE_ESSAI_S : le temps d\'un aller et retour', () => expect(PAUSE_ESSAI_S).toBe(120));

/** IP de l'appelant : ce que Traefik écrit, jamais ce que l'appelant écrit ; une IPv6 compte par /64 (23/11). */
import { describe, expect, it } from 'vitest';

import { cleIp, ipClient, vueIp } from '@/lib/auth/ip-client';

const h = (xff: string, plus: Record<string, string> = {}) => new Headers({ 'x-forwarded-for': xff, ...plus });
const BORD_CF = '172.70.1.2';

describe('ip-client', () => {
  it('par Cloudflare : le visiteur ajouté par Cloudflare, jamais le bord (tout le monde dans le même seau)', () => {
    expect(cleIp(h(`198.51.100.7, ${BORD_CF}`))).toBe('198.51.100.7');
    expect(cleIp(h(`198.51.100.8, ${BORD_CF}`))).not.toBe(cleIp(h(`198.51.100.7, ${BORD_CF}`)));
  });

  it('par Cloudflare, X-Forwarded-For forgé par le visiteur : sans effet', () => {
    for (let i = 0; i < 5; i++) expect(cleIp(h(`9.9.9.${i}, 198.51.100.7, ${BORD_CF}`))).toBe('198.51.100.7');
  });

  it('appelant direct (Traefik n\'a laissé que le pair) : cf-connecting-ip et x-real-ip forgés sans effet', () => {
    for (let i = 0; i < 5; i++) {
      expect(cleIp(h('203.0.113.5', { 'cf-connecting-ip': `9.9.9.${i}`, 'x-real-ip': `8.8.8.${i}`, 'true-client-ip': `7.7.7.${i}` }))).toBe('203.0.113.5');
    }
  });

  it('machine du parc ou du tailnet : elle-même, même si elle annonce un visiteur', () => {
    for (const pair of ['100.81.160.83', '10.1.2.3', '172.26.64.9', '192.168.1.4', 'fd7a:115c:a1e0::1']) {
      expect(ipClient(h(`9.9.9.9, ${pair}`, { 'cf-connecting-ip': '9.9.9.9' })), pair).toBe(pair);
    }
  });

  it('cloudflared en boucle locale : le visiteur', () => {
    expect(cleIp(h('198.51.100.7, 127.0.0.1'))).toBe('198.51.100.7');
    expect(cleIp(h('198.51.100.7, ::1'))).toBe('198.51.100.7');
  });

  it('IPv6 : un abonné ne change pas de clé dans son /64 ; un autre /64 est un autre appelant', () => {
    const cles = new Set(['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:0DB8:0001:0002:a:b:c:d'].map((ip) => cleIp(h(`${ip}, ${BORD_CF}`))));
    expect(Array.from(cles)).toEqual(['2001:db8:1:2::/64']);
    expect(cleIp(h(`2001:db8:1:3::1, ${BORD_CF}`))).toBe('2001:db8:1:3::/64');
    expect(cleIp(h(`2001:db8::1, ${BORD_CF}`))).toBe('2001:db8:0:0::/64');
    expect(ipClient(h(`2001:db8:1:2::1, ${BORD_CF}`)), 'adresse exacte pour la mesure').toBe('2001:db8:1:2::1');
  });

  it('IPv4 déguisée en IPv6 : la même clé que l\'IPv4', () => {
    expect(cleIp(h(`::ffff:198.51.100.7, ${BORD_CF}`))).toBe('198.51.100.7');
  });

  it('illisible ou absent : inconnu, sans croire les autres en-têtes', () => {
    expect(cleIp(new Headers({ 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '1.2.3.4' }))).toBe('unknown');
    expect(cleIp(h(''))).toBe('unknown');
    expect(cleIp(h('1.2.3.4, pas-une-ip'))).toBe('unknown');
    expect(vueIp(h(`1.2.3.4, ${BORD_CF}`))).toEqual({ ip: '1.2.3.4', source: 'avant-pair', elements: 2 });
  });
});

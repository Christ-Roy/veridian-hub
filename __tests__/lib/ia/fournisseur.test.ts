/**
 * Fournisseur « Veridian » du chat natif de Twenty : refus sur tout écart d'authentification (docs/MON-IA.md),
 * relais transparent pour la clé API, session liée au fil (menace 7).
 */
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIENCE_FOURNISSEUR,
  EMETTEUR_CRM,
  type ConsommerJti,
  appelerFournisseur,
  corpsRelaye,
  derniereQuestionOpenAI,
  relaisAvecMesure,
  sessionDuFil,
  verifierAppel,
} from '@/lib/ia/fournisseur';

const CLE = 'i'.repeat(40);
const SECRET = 's'.repeat(40);
const env = { IA_FOURNISSEUR_CLE: CLE, IA_IDENTITE_SECRET: SECRET } as NodeJS.ProcessEnv;
const WS = '38627be0-428f-4924-aa67-4a35884ba7b4';
const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const NOW = 1_795_400_000_000;

async function jeton(o: { secret?: string; iss?: string; aud?: string; duree?: number; iat?: number; jti?: string; claims?: Record<string, unknown> } = {}) {
  const iat = o.iat ?? Math.floor(NOW / 1000);
  return new SignJWT({ workspace_id: WS, hub_user_id: ROBERT, fil: 'fil-1', ...(o.claims ?? {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(o.iss ?? EMETTEUR_CRM)
    .setAudience(o.aud ?? AUDIENCE_FOURNISSEUR)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (o.duree ?? 60))
    .setJti(o.jti ?? Math.random().toString(36))
    .sign(new TextEncoder().encode(o.secret ?? SECRET));
}
const entetes = (j: string | null, cle: string | null = CLE) => {
  const h = new Headers();
  if (cle) h.set('authorization', `Bearer ${cle}`);
  if (j) h.set('x-veridian-ia-identite', j);
  return h;
};

/** Le magasin partagé des jti (la base, en prod). Vidé entre tests ; la mémoire d'un processus n'y entre pas. */
let vus = new Set<string>();
const base: ConsommerJti = async (jti) => {
  if (vus.has(jti)) return false;
  vus.add(jti);
  return true;
};
beforeEach(() => {
  vus = new Set<string>();
});

describe('verifierAppel', () => {
  it('nominal : le membre, son workspace et son fil', async () => {
    expect(await verifierAppel(entetes(await jeton()), base, env, NOW)).toEqual({ workspaceId: WS, hubUserId: ROBERT, fil: 'fil-1' });
  });

  it('chaque écart est refusé', async () => {
    const cas: [string, Headers][] = [
      ['clé d\'instance absente', entetes(await jeton(), null)],
      ['clé d\'instance fausse', entetes(await jeton(), 'x'.repeat(40))],
      ['jeton absent', entetes(null)],
      ['signature d\'un autre secret', entetes(await jeton({ secret: 'z'.repeat(40) }))],
      ['émetteur faux', entetes(await jeton({ iss: 'autre' }))],
      ['audience fausse', entetes(await jeton({ aud: 'https://evil.example/v1' }))],
      ['expiré', entetes(await jeton({ iat: Math.floor(NOW / 1000) - 120 }))],
      ['durée trop longue', entetes(await jeton({ duree: 3600 }))],
      ['workspace illisible', entetes(await jeton({ claims: { workspace_id: 'pas-un-uuid' } }))],
      ['fil interdit', entetes(await jeton({ claims: { fil: '../autre' } }))],
    ];
    for (const [nom, h] of cas) expect('refus' in (await verifierAppel(h, base, env, NOW)), nom).toBe(true);
  });

  it('fil nul (génération simple) : accepté, fil « sans-fil »', async () => {
    expect(await verifierAppel(entetes(await jeton({ claims: { fil: null } })), base, env, NOW)).toEqual({ workspaceId: WS, hubUserId: ROBERT, fil: 'sans-fil' });
  });

  it('agent sans membre (hub_user_id nul) : refus nommé', async () => {
    expect(await verifierAppel(entetes(await jeton({ claims: { hub_user_id: null } })), base, env, NOW)).toEqual({ refus: 'agent_sans_membre' });
  });

  it('jti rejoué : refusé la seconde fois', async () => {
    const j = await jeton({ jti: 'unique-1' });
    expect('refus' in (await verifierAppel(entetes(j), base, env, NOW))).toBe(false);
    expect(await verifierAppel(entetes(j), base, env, NOW)).toEqual({ refus: 'identite_rejouee' });
  });

  it('jti rejoué sur une AUTRE instance (mémoire vide, base partagée) : refusé', async () => {
    const j = await jeton({ jti: 'unique-2' });
    expect('refus' in (await verifierAppel(entetes(j), base, env, NOW))).toBe(false);
    expect(await verifierAppel(entetes(j), base, env, NOW)).toEqual({ refus: 'identite_rejouee' });
  });

  it('secrets absents ou courts : fermé', async () => {
    expect(await verifierAppel(entetes(await jeton()), base, {} as NodeJS.ProcessEnv, NOW)).toEqual({ refus: 'fournisseur_non_configure' });
  });
});

describe('session du fil (menace 7)', () => {
  it('stable pour un triplet et un fil ; différente pour un autre tenant, membre ou fil', () => {
    const t = { hubUserId: ROBERT, app: 'crm', tenantId: 't1' };
    expect(sessionDuFil(t, 'f')).toBe(sessionDuFil(t, 'f'));
    expect(sessionDuFil(t, 'f')).not.toBe(sessionDuFil({ ...t, tenantId: 't2' }, 'f'));
    expect(sessionDuFil(t, 'f')).not.toBe(sessionDuFil({ ...t, hubUserId: 'autre' }, 'f'));
    expect(sessionDuFil(t, 'f')).not.toBe(sessionDuFil(t, 'g'));
    expect(sessionDuFil(t, 'f')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('relais clé API', () => {
  it('modèle et clé de l\'utilisateur, outils de Twenty tels quels, usage demandé', () => {
    const c = corpsRelaye({ model: 'veridian-auto', stream: true, messages: [], tools: [{ type: 'function' }] }, 'anthropic', 'claude-sonnet-5-5');
    expect(c).toMatchObject({ model: 'claude-sonnet-5-5', tools: [{ type: 'function' }], stream_options: { include_usage: true } });
  });

  it('erreur du fournisseur : jamais son corps (il peut citer la clé), un code seulement', async () => {
    const f = vi.fn(async () => new Response('{"error":"invalid key sk-ant-SECRET-123456789012345"}', { status: 401 })) as unknown as typeof fetch;
    expect(await appelerFournisseur({ fournisseur: 'anthropic', modele: 'm', cle: 'sk-ant-SECRET-123456789012345' }, { messages: [] }, f)).toEqual({ refus: 'cle_refusee' });
  });

  it('le flux passe tel quel ; jetons et appels d\'outils relevés pour l\'audit', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1","function":{"name":"x"}}]}}]}',
      'data: {"choices":[],"usage":{"total_tokens":42}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fin = vi.fn();
    const sortie = await new Response(relaisAvecMesure(new Response(sse).body!, fin)).text();
    expect(sortie).toBe(sse);
    expect(fin).toHaveBeenCalledWith({ jetons: 42, outils: 1 });
  });

  it('dernière question : texte simple ou parties', () => {
    expect(derniereQuestionOpenAI([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: [{ type: 'text', text: 'c' }] }])).toBe('c');
  });
});

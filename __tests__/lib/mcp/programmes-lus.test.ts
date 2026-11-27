/** Programmes lus dans le journal : en cours, perdus, terminés ; essai reconnu à l'adresse, inconnu compté client ; aucune adresse rendue. */
import { describe, expect, it } from 'vitest';

import { ACTION_DEBUT, EN_COURS_MAX_MS, lireProgrammes, type DbProgrammes } from '@/lib/mcp/programmes-lus';

const T0 = Date.parse('2026-11-26T12:00:00Z');
const a = (min: number) => new Date(T0 - min * 60_000);
const ligne = (action: string, qui: string, programme: string, min: number, payload: Record<string, unknown> = {}) => ({ action, targetId: qui, payload: { programme, ...payload }, createdAt: a(min) });
const db = (lignes: ReturnType<typeof ligne>[]): DbProgrammes => ({
  auditLog: { findMany: async () => lignes },
  user: { findMany: async () => [{ supabaseUserId: 'u-essai', email: 'e2e-sso-moteur-1@veridian.site' }, { supabaseUserId: 'u-client', email: 'quelqu.un@client.fr' }] },
});

describe('lireProgrammes', () => {
  it('un début sans fin récent est en cours, ancien il est perdu ; un début suivi de sa fin est terminé', async () => {
    const r = await lireProgrammes(db([
      ligne('mcp.programme.debut', 'u-client', 'p1', 1),
      ligne('mcp.programme.debut', 'u-essai', 'p2', EN_COURS_MAX_MS / 60_000 + 1),
      ligne('mcp.programme.debut', 'u-essai', 'p3', 30),
      ligne('mcp.programme', 'u-essai', 'p3', 29, { etat: 'termine', ms: 800 }),
    ]), a(120), T0);
    expect([r.en_cours.map((p) => [p.programme, p.qui]), r.perdus.map((p) => p.programme), r.termines, r.aucun_client_en_cours]).toEqual([[['p1', 'client']], ['p2'], { essai: 1, client: 0 }, false]);
  });
  it('seuls des essais tournent : aucun client en cours ; le dernier programme client se lit, même terminé', async () => {
    const r = await lireProgrammes(db([
      ligne('mcp.programme', 'u-client', 'p0', 90, { etat: 'termine' }),
      ligne('mcp.programme.debut', 'u-essai', 'p1', 1),
    ]), a(120), T0);
    expect([r.aucun_client_en_cours, r.dernier_client, r.termines]).toEqual([true, a(90).toISOString(), { essai: 0, client: 1 }]);
  });
  it('essai noté à l\'écriture : reconnu même après la suppression du compte', async () => {
    const r = await lireProgrammes(db([ligne('mcp.programme.debut', 'u-supprime', 'p1', 1, { essai: true }), ligne('mcp.programme.debut', 'u-supprime', 'p2', 1, { essai: false })]), a(120), T0);
    expect(r.en_cours.map((p) => [p.programme, p.qui])).toEqual([['p1', 'essai'], ['p2', 'client']]);
  });
  it('un compte introuvable compte client, jamais essai ; aucune adresse ne sort', async () => {
    const r = await lireProgrammes(db([ligne('mcp.programme.debut', 'u-supprime', 'p1', 1)]), a(120), T0);
    expect([r.en_cours[0].qui, r.aucun_client_en_cours, JSON.stringify(r).includes('@')]).toEqual(['client', false, false]);
  });
  it('le nom du début est celui qu\'écrit la porte, et la lecture ne demande que les débuts et les fins', async () => {
    let filtre: unknown;
    await lireProgrammes({ auditLog: { findMany: async (a) => { filtre = a; return []; } }, user: { findMany: async () => [] } }, a(60), T0);
    expect([ACTION_DEBUT, (filtre as { where: { action: { in: string[] } } }).where.action.in]).toEqual(['mcp.programme.debut', ['mcp.programme.debut', 'mcp.programme']]);
  });
});

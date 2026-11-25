import { beforeEach, describe, expect, it } from 'vitest';

import { chaineAcceptable, disjoncteur, leverPause, noterEcriture, objetDuLien } from '@/lib/evenements/anti-boucle';

import { base } from './fausse';

const NOW = 1_800_000_000_000;
const L = { tenantId: 'T', paire: 'notifuse>crm', objetSource: 'abc' };
let db: ReturnType<typeof base>;
beforeEach(() => { db = base(); });
const ecrire = async (n: number, t = NOW) => { for (let i = 0; i < n; i++) await noterEcriture(db as never, { ...L, evenementId: `e${i}` }, t); };

describe('chaineAcceptable', () => {
  it('vide ou de trois maillons : passe ; quatre, ou la même paire déjà dedans : refusée', () => {
    expect(chaineAcceptable([], 'notifuse>crm')).toBe(true);
    expect(chaineAcceptable(['crm>prospection:a', 'prospection>crm:b', 'crm>notifuse:c'], 'notifuse>crm')).toBe(true);
    expect(chaineAcceptable(['a:1', 'b:2', 'c:3', 'd:4'], 'notifuse>crm')).toBe(false);
    expect(chaineAcceptable(['crm>prospection:a', 'notifuse>crm:b'], 'notifuse>crm')).toBe(false);
  });
});

describe('objetDuLien', () => {
  it('stable par adresse, différent d\'une adresse à l\'autre, jamais l\'adresse', () => {
    expect(objetDuLien('a@x.test')).toBe(objetDuLien('a@x.test'));
    expect(objetDuLien('a@x.test')).not.toBe(objetDuLien('b@x.test'));
    expect(objetDuLien('a@x.test')).not.toContain('a@x');
  });
});

describe('disjoncteur', () => {
  it('cinq écritures en 10 min passent, la sixième met la paire en pause, visible dans les Liaisons', async () => {
    await db.integrationPaire.upsert({ where: { tenantId: 'T', paire: 'notifuse>crm' }, create: { tenantId: 'T', paire: 'notifuse>crm', etat: 'allumee' }, update: {} });
    await ecrire(4);
    expect(await disjoncteur(db as never, L, NOW)).toBe('ok');
    await ecrire(1);
    expect(await disjoncteur(db as never, L, NOW)).toBe('pause');
    expect(db.integrationPause.lignes).toHaveLength(1);
    expect(db.integrationPaire.lignes[0].derniereErreur).toBe('pause_disjoncteur');
    expect(db.auditLog.lignes[0]).toMatchObject({ action: 'integration.pause' });
  });
  it('la pause tient même une fois la fenêtre écoulée ; un autre contact ou une autre organisation n\'est pas touché', async () => {
    await ecrire(5);
    expect(await disjoncteur(db as never, L, NOW)).toBe('pause');
    expect(await disjoncteur(db as never, L, NOW + 3_600_000)).toBe('pause');
    expect(await disjoncteur(db as never, { ...L, tenantId: 'T2' }, NOW)).toBe('ok');
  });
  it('des écritures de plus de 10 min ne comptent pas, ni celles d\'un autre contact', async () => {
    await ecrire(5, NOW - 11 * 60_000);
    expect(await disjoncteur(db as never, L, NOW)).toBe('ok');
    await ecrire(5);
    expect(await disjoncteur(db as never, { ...L, objetSource: 'autre' }, NOW)).toBe('ok');
  });
});

describe('noterEcriture', () => {
  it('garde une ligne par écriture et efface ce qui a plus de 24 h', async () => {
    await ecrire(2, NOW - 25 * 3_600_000);
    await ecrire(1);
    expect(db.integrationLien.lignes).toHaveLength(1);
  });
});

describe('leverPause', () => {
  beforeEach(async () => {
    await db.tenant.create({ data: { id: 'T', userId: 'proprio', status: 'active', deletedAt: null } });
    await db.integrationPaire.upsert({ where: { tenantId: 'T', paire: 'notifuse>crm' }, create: { tenantId: 'T', paire: 'notifuse>crm', derniereErreur: 'pause_disjoncteur' }, update: {} });
    await db.integrationPause.upsert({ where: { tenantId: 'T', paire: 'notifuse>crm' }, create: { tenantId: 'T', paire: 'notifuse>crm', motif: 'm' }, update: {} });
  });
  it('un membre simple ne lève rien ; le propriétaire lève et la trace reste', async () => {
    expect(await leverPause(db as never, { tenantId: 'T', paire: 'notifuse>crm', hubUserId: 'inconnu' })).toBe(false);
    expect(db.integrationPause.lignes).toHaveLength(1);
    expect(await leverPause(db as never, { tenantId: 'T', paire: 'notifuse>crm', hubUserId: 'proprio' })).toBe(true);
    expect(db.integrationPause.lignes).toHaveLength(0);
    expect(db.integrationPaire.lignes[0].derniereErreur).toBeNull();
    expect(db.auditLog.lignes.at(-1)).toMatchObject({ action: 'integration.pause_levee' });
    expect(await leverPause(db as never, { tenantId: 'T', paire: 'notifuse>crm', hubUserId: 'proprio' })).toBe(false);
  });
});

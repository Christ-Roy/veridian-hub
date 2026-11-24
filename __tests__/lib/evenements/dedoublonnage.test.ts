import { beforeEach, describe, expect, it } from 'vitest';

import { liberer, reserver, terminer } from '@/lib/evenements/dedoublonnage';

import { base } from './fausse';

const C = { source: 'notifuse', evenementId: 'liv-1', messageId: 'm-1', cleRfc: 'ws:abc@x', tenantId: 'T' };
const NOW = 1_800_000_000_000;
let db: ReturnType<typeof base>;
beforeEach(() => { db = base(); });

describe('dedoublonnage', () => {
  it('reserver : le premier passe, la même livraison ne passe pas deux fois', async () => {
    expect(await reserver(db as never, C, NOW)).toBe('neuf');
    expect(await reserver(db as never, C, NOW + 1_000)).toBe('en_cours');
    await terminer(db as never, C, 'fait', undefined, NOW);
    expect(await reserver(db as never, C, NOW + 2_000)).toBe('deja');
  });
  it('même mail, autre livraison : refusé par message_id, et par Message-ID RFC', async () => {
    await reserver(db as never, C, NOW);
    await terminer(db as never, C, 'fait', undefined, NOW);
    expect(await reserver(db as never, { ...C, evenementId: 'liv-2' }, NOW)).toBe('deja');
    expect(await reserver(db as never, { ...C, evenementId: 'liv-3', messageId: 'm-2' }, NOW)).toBe('deja');
    expect(await reserver(db as never, { ...C, evenementId: 'liv-4', messageId: 'm-3', cleRfc: null }, NOW)).toBe('neuf');
  });
  it('liberer : un échec laisse la source réessayer ; une ligne morte se reprend après 3 min', async () => {
    await reserver(db as never, C, NOW);
    await liberer(db as never, C);
    expect(await reserver(db as never, C, NOW)).toBe('neuf');
    expect(await reserver(db as never, C, NOW + 179_000)).toBe('en_cours');
    expect(await reserver(db as never, C, NOW + 181_000)).toBe('neuf');
  });
  it('liberer ne touche pas un événement déjà fait ; terminer purge ce qui a plus de 30 jours', async () => {
    await reserver(db as never, C, NOW);
    await terminer(db as never, C, 'fait', undefined, NOW);
    await liberer(db as never, C);
    expect(db.evenementRecu.lignes).toHaveLength(1);
    await terminer(db as never, { ...C, messageId: 'm-9' }, 'ignore', 'pause', NOW + 31 * 86_400_000);
    expect(db.evenementRecu.lignes).toHaveLength(0);
  });
});

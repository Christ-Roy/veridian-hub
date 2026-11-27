/** zod sans eval (VER-265) : une fois le module chargé, construire et valider un schéma objet n'essaie jamais Function. */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('zod-sans-eval', () => {
  afterEach(() => vi.restoreAllMocks());
  it('jitless posé ; un schéma objet construit APRÈS ne touche pas à Function, et valide pareil', async () => {
    await import('@/lib/zod-sans-eval');
    const { z } = await import('zod');
    const { globalConfig } = await import('zod/v4/core');
    const espion = vi.spyOn(globalThis, 'Function');
    const s = z.object({ a: z.string(), b: z.number() });
    const ok = s.safeParse({ a: 'x', b: 1 });
    const ko = s.safeParse({ a: 1 });
    expect([globalConfig.jitless, espion.mock.calls.length, ok.success, ko.success]).toEqual([true, 0, true, false]);
  });
});

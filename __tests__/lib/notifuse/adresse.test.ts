// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { suivreAdresseMail } from '@/lib/notifuse/adresse';

it('suivreAdresseMail : les espaces de SON propriétaire, vivants, qui en avaient une ; rien n\'est inventé ailleurs', async () => {
  const updateMany = vi.fn(async (..._a: unknown[]) => ({ count: 2 }));
  expect(await suivreAdresseMail({ tenant: { updateMany } } as never, 'h1', 'neuve@x.fr')).toBe(2);
  expect(updateMany.mock.calls[0][0]).toEqual({ where: { userId: 'h1', deletedAt: null, notifuseUserEmail: { not: null } }, data: { notifuseUserEmail: 'neuve@x.fr' } });
});

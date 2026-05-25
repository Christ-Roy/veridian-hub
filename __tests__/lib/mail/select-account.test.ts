/**
 * Tests unitaires lib/mail/select-account.ts.
 *
 * Couvre la logique de sélection du compte Mail :
 *  - Mode v1.0 / v1.1 sans mailAccountId : isDefaultForMail → fallback gmail.send
 *  - Mode v1.1 avec mailAccountId : check userId-bound + scope
 *  - Erreurs typées (User / Account / ProviderNotLinked)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  selectMailAccount,
  MailAccountNotFoundError,
} from '@/lib/mail/select-account';
import {
  MailUserNotFoundError,
  MailProviderNotLinkedError,
} from '@/lib/mail/send-gmail';

function makePrismaMock(opts: {
  user?: { id: string } | null;
  accountByIdLookup?: any;
  accounts?: any[];
}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(opts.user ?? null),
    },
    account: {
      findUnique: vi.fn().mockResolvedValue(opts.accountByIdLookup ?? null),
      findMany: vi.fn().mockResolvedValue(opts.accounts ?? []),
    },
  } as any;
}

const VALID_SCOPE =
  'openid email profile https://www.googleapis.com/auth/gmail.send';

describe('selectMailAccount — explicit mailAccountId', () => {
  it('returns Account when valid + belongs to user + has gmail.send', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accountByIdLookup: {
        id: 'acc_clx_chosen',
        userId: 'cuid_alice',
        provider: 'google',
        refresh_token: 'rt',
        access_token: 'at',
        expires_at: 999,
        mailSendScope: VALID_SCOPE,
        mailSendNeedsReauth: false,
        isDefaultForMail: false,
      },
    });

    const result = await selectMailAccount('cuid_alice', 'acc_clx_chosen', {
      prisma,
    });
    expect(result.id).toBe('acc_clx_chosen');
    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { id: 'acc_clx_chosen' },
      select: expect.any(Object),
    });
  });

  it('throws MailUserNotFoundError when user does not exist', async () => {
    const prisma = makePrismaMock({ user: null });
    await expect(
      selectMailAccount('cuid_ghost', 'acc_x', { prisma }),
    ).rejects.toBeInstanceOf(MailUserNotFoundError);
  });

  it('throws MailAccountNotFoundError when account does not exist', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accountByIdLookup: null,
    });
    await expect(
      selectMailAccount('cuid_alice', 'acc_does_not_exist', { prisma }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
  });

  it('throws MailAccountNotFoundError when account belongs to another user (sec)', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accountByIdLookup: {
        id: 'acc_clx_chosen',
        userId: 'cuid_bob', // different user
        provider: 'google',
        refresh_token: 'rt',
        access_token: 'at',
        expires_at: 999,
        mailSendScope: VALID_SCOPE,
        mailSendNeedsReauth: false,
        isDefaultForMail: false,
      },
    });
    await expect(
      selectMailAccount('cuid_alice', 'acc_clx_chosen', { prisma }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
  });

  it('throws MailAccountNotFoundError when account has no gmail.send scope', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accountByIdLookup: {
        id: 'acc_basic',
        userId: 'cuid_alice',
        provider: 'google',
        refresh_token: 'rt',
        access_token: 'at',
        expires_at: 999,
        mailSendScope: 'openid email profile',
        mailSendNeedsReauth: false,
        isDefaultForMail: false,
      },
    });
    await expect(
      selectMailAccount('cuid_alice', 'acc_basic', { prisma }),
    ).rejects.toBeInstanceOf(MailAccountNotFoundError);
  });
});

describe('selectMailAccount — auto-resolution (no mailAccountId)', () => {
  it('returns the isDefaultForMail account when set', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accounts: [
        // Prisma renvoie déjà trié par isDefaultForMail desc (ordering du caller)
        {
          id: 'acc_default',
          provider: 'google',
          refresh_token: 'rt',
          access_token: 'at',
          expires_at: 999,
          mailSendScope: VALID_SCOPE,
          mailSendNeedsReauth: false,
          isDefaultForMail: true,
        },
        {
          id: 'acc_other',
          provider: 'google',
          refresh_token: 'rt2',
          access_token: 'at2',
          expires_at: 999,
          mailSendScope: VALID_SCOPE,
          mailSendNeedsReauth: false,
          isDefaultForMail: false,
        },
      ],
    });
    const result = await selectMailAccount('cuid_alice', undefined, { prisma });
    expect(result.id).toBe('acc_default');
  });

  it('falls back to first gmail.send account when no isDefaultForMail set', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accounts: [
        // Premier dans la liste (déjà trié id asc côté Prisma).
        {
          id: 'acc_first',
          provider: 'google',
          refresh_token: 'rt',
          access_token: 'at',
          expires_at: 999,
          mailSendScope: VALID_SCOPE,
          mailSendNeedsReauth: false,
          isDefaultForMail: false,
        },
      ],
    });
    const result = await selectMailAccount('cuid_alice', undefined, { prisma });
    expect(result.id).toBe('acc_first');
  });

  it('skips accounts without gmail.send scope', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accounts: [
        {
          id: 'acc_basic',
          provider: 'google',
          refresh_token: 'rt',
          access_token: 'at',
          expires_at: 999,
          mailSendScope: 'openid email profile',
          mailSendNeedsReauth: false,
          isDefaultForMail: false,
        },
        {
          id: 'acc_full',
          provider: 'google',
          refresh_token: 'rt2',
          access_token: 'at2',
          expires_at: 999,
          mailSendScope: VALID_SCOPE,
          mailSendNeedsReauth: false,
          isDefaultForMail: false,
        },
      ],
    });
    const result = await selectMailAccount('cuid_alice', undefined, { prisma });
    expect(result.id).toBe('acc_full');
  });

  it('throws MailProviderNotLinkedError when no eligible account', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accounts: [
        {
          id: 'acc_basic',
          provider: 'google',
          refresh_token: 'rt',
          access_token: 'at',
          expires_at: 999,
          mailSendScope: 'openid email profile',
          mailSendNeedsReauth: false,
          isDefaultForMail: false,
        },
      ],
    });
    await expect(
      selectMailAccount('cuid_alice', undefined, { prisma }),
    ).rejects.toBeInstanceOf(MailProviderNotLinkedError);
  });

  it('throws MailProviderNotLinkedError when no refresh_token (legacy account)', async () => {
    const prisma = makePrismaMock({
      user: { id: 'cuid_alice' },
      accounts: [
        {
          id: 'acc_no_refresh',
          provider: 'google',
          refresh_token: null,
          access_token: 'at',
          expires_at: 999,
          mailSendScope: VALID_SCOPE,
          mailSendNeedsReauth: false,
          isDefaultForMail: true,
        },
      ],
    });
    await expect(
      selectMailAccount('cuid_alice', undefined, { prisma }),
    ).rejects.toBeInstanceOf(MailProviderNotLinkedError);
  });
});

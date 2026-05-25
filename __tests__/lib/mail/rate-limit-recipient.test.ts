/**
 * Tests unitaires lib/mail/rate-limit-recipient.ts.
 *
 * Couvre :
 *  - normalizeRecipient : casse + trim
 *  - checkRecipientRateLimit : allowed / blocked / retry_after exact
 *  - recordRecipientSent : upsert correct
 *  - recordRateLimitBlocked : create correct
 *  - shouldBypassRecipientRateLimit : timing-safe, gate prod, gate secret length
 *  - normalisation casse anti-bypass
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  normalizeRecipient,
  checkRecipientRateLimit,
  recordRecipientSent,
  recordRateLimitBlocked,
  shouldBypassRecipientRateLimit,
  MAIL_RATE_LIMIT_WINDOW_MS,
} from '@/lib/mail/rate-limit-recipient';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('normalizeRecipient', () => {
  it('lowercases', () => {
    expect(normalizeRecipient('Alice@Example.COM')).toBe('alice@example.com');
  });
  it('trims', () => {
    expect(normalizeRecipient('  bob@x.com  ')).toBe('bob@x.com');
  });
  it('combines', () => {
    expect(normalizeRecipient('  ALICE@X.com\n')).toBe('alice@x.com');
  });
});

describe('checkRecipientRateLimit', () => {
  it('returns allowed for fresh recipient (no row)', async () => {
    const prisma = {
      mailRecipientRateLimit: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any;
    const result = await checkRecipientRateLimit(['fresh@x.com'], { prisma });
    expect(result).toEqual([{ allowed: true, recipient: 'fresh@x.com' }]);
  });

  it('returns blocked with retry_after when within window', async () => {
    const now = 1_700_000_000_000;
    // Mail envoyé il y a 5min (300_000ms). Window = 20min (1_200_000ms).
    // Retry = (1_200_000 - 300_000) / 1000 = 900s.
    const lastSent = new Date(now - 5 * 60_000);
    const prisma = {
      mailRecipientRateLimit: {
        findMany: vi.fn().mockResolvedValue([
          { recipientEmail: 'bob@x.com', lastSentAt: lastSent },
        ]),
      },
    } as any;
    const result = await checkRecipientRateLimit(['bob@x.com'], {
      prisma,
      now: () => now,
    });
    expect(result[0].allowed).toBe(false);
    if (!result[0].allowed) {
      expect(result[0].recipient).toBe('bob@x.com');
      expect(result[0].retryAfterSeconds).toBe(900);
    }
  });

  it('returns allowed when window has elapsed', async () => {
    const now = 1_700_000_000_000;
    // Mail envoyé il y a 21 min — fenêtre 20 min écoulée.
    const lastSent = new Date(now - 21 * 60_000);
    const prisma = {
      mailRecipientRateLimit: {
        findMany: vi.fn().mockResolvedValue([
          { recipientEmail: 'old@x.com', lastSentAt: lastSent },
        ]),
      },
    } as any;
    const result = await checkRecipientRateLimit(['old@x.com'], {
      prisma,
      now: () => now,
    });
    expect(result[0].allowed).toBe(true);
  });

  it('handles mixed batch (some allowed, some blocked)', async () => {
    const now = 1_700_000_000_000;
    const prisma = {
      mailRecipientRateLimit: {
        findMany: vi.fn().mockResolvedValue([
          { recipientEmail: 'spam@x.com', lastSentAt: new Date(now - 60_000) },
        ]),
      },
    } as any;
    const result = await checkRecipientRateLimit(
      ['fresh@x.com', 'spam@x.com', 'fresh2@x.com'],
      { prisma, now: () => now },
    );
    expect(result[0].allowed).toBe(true);
    expect(result[1].allowed).toBe(false);
    expect(result[2].allowed).toBe(true);
  });

  it('normalizes case (anti-bypass)', async () => {
    const now = 1_700_000_000_000;
    const prisma = {
      mailRecipientRateLimit: {
        findMany: vi.fn().mockResolvedValue([
          { recipientEmail: 'foo@x.com', lastSentAt: new Date(now - 1000) },
        ]),
      },
    } as any;
    // Le caller envoie FOO@X.COM → doit être bloqué (même bucket).
    const result = await checkRecipientRateLimit(['FOO@X.COM'], {
      prisma,
      now: () => now,
    });
    expect(result[0].allowed).toBe(false);
    // Vérifie que findMany a été appelé avec la version normalisée.
    expect(prisma.mailRecipientRateLimit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipientEmail: { in: ['foo@x.com'] } },
      }),
    );
  });

  it('handles duplicate recipients (one bucket lookup)', async () => {
    const now = 1_700_000_000_000;
    const prisma = {
      mailRecipientRateLimit: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any;
    // 2 fois le même destinataire (déduplication côté findMany).
    const result = await checkRecipientRateLimit(['a@x.com', 'a@x.com'], {
      prisma,
      now: () => now,
    });
    // Le résultat garde les 2 entrées.
    expect(result).toHaveLength(2);
    // Mais le findMany ne contient qu'une seule fois.
    const callArg = prisma.mailRecipientRateLimit.findMany.mock.calls[0][0];
    expect(callArg.where.recipientEmail.in).toEqual(['a@x.com']);
  });
});

describe('recordRecipientSent', () => {
  it('upserts with normalized email + sender + caller', async () => {
    const prisma = {
      mailRecipientRateLimit: {
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as any;
    await recordRecipientSent(
      {
        recipientEmail: 'BOB@example.com',
        senderUserId: 'cuid_alice',
        appCaller: 'notifuse',
      },
      { prisma },
    );
    expect(prisma.mailRecipientRateLimit.upsert).toHaveBeenCalledWith({
      where: { recipientEmail: 'bob@example.com' },
      create: expect.objectContaining({
        recipientEmail: 'bob@example.com',
        senderUserId: 'cuid_alice',
        appCaller: 'notifuse',
      }),
      update: expect.objectContaining({
        senderUserId: 'cuid_alice',
        appCaller: 'notifuse',
      }),
    });
  });
});

describe('recordRateLimitBlocked', () => {
  it('inserts an event with retry_after for forensics', async () => {
    const prisma = {
      mailRateLimitEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    } as any;
    await recordRateLimitBlocked(
      {
        recipientEmail: 'SPAM@x.com',
        senderUserId: 'cuid_alice',
        appCaller: 'prospection',
        retryAfterSeconds: 1200,
      },
      { prisma },
    );
    expect(prisma.mailRateLimitEvent.create).toHaveBeenCalledWith({
      data: {
        recipientEmail: 'spam@x.com',
        senderUserId: 'cuid_alice',
        appCaller: 'prospection',
        retryAfterSeconds: 1200,
      },
    });
  });
});

describe('shouldBypassRecipientRateLimit', () => {
  const VALID_SECRET = 'a'.repeat(32);

  it('returns false when DEPLOY_ENV=prod (even with valid secret + header)', () => {
    process.env.DEPLOY_ENV = 'prod';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = VALID_SECRET;
    const headers = new Headers({ 'x-veridian-bypass-rate-limit': VALID_SECRET });
    expect(shouldBypassRecipientRateLimit(headers)).toBe(false);
  });

  it('returns false when secret too short (< 32 chars)', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = 'tooshort';
    const headers = new Headers({ 'x-veridian-bypass-rate-limit': 'tooshort' });
    expect(shouldBypassRecipientRateLimit(headers)).toBe(false);
  });

  it('returns false when no header provided', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = VALID_SECRET;
    const headers = new Headers();
    expect(shouldBypassRecipientRateLimit(headers)).toBe(false);
  });

  it('returns false when header mismatches secret', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = VALID_SECRET;
    const headers = new Headers({
      'x-veridian-bypass-rate-limit': 'b'.repeat(32), // bonne longueur, mauvais content
    });
    expect(shouldBypassRecipientRateLimit(headers)).toBe(false);
  });

  it('returns true when secret matches + non-prod', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = VALID_SECRET;
    const headers = new Headers({ 'x-veridian-bypass-rate-limit': VALID_SECRET });
    expect(shouldBypassRecipientRateLimit(headers)).toBe(true);
  });

  it('handles length mismatch without throwing (timing normalization)', () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = VALID_SECRET;
    const headers = new Headers({
      'x-veridian-bypass-rate-limit': 'short',
    });
    expect(() => shouldBypassRecipientRateLimit(headers)).not.toThrow();
    expect(shouldBypassRecipientRateLimit(headers)).toBe(false);
  });

  it('allows in prod when allowInProd=true (admin override)', () => {
    process.env.DEPLOY_ENV = 'prod';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = VALID_SECRET;
    const headers = new Headers({ 'x-veridian-bypass-rate-limit': VALID_SECRET });
    expect(shouldBypassRecipientRateLimit(headers, { allowInProd: true })).toBe(
      true,
    );
  });
});

describe('MAIL_RATE_LIMIT_WINDOW_MS', () => {
  it('is 20 minutes', () => {
    expect(MAIL_RATE_LIMIT_WINDOW_MS).toBe(20 * 60 * 1000);
  });
});

/**
 * Tests send-gmail.ts — lib/mail/send-gmail.ts
 *
 * Couvre :
 *   - idempotent replay (mail_events.idempotency_key existant, status='sent')
 *   - idempotent_key existant avec status='failed' → throw
 *   - user introuvable → MailUserNotFoundError
 *   - aucun Account google avec gmail.send scope → MailProviderNotLinkedError
 *   - access_token valide (expires_at futur) → pas de refresh, envoi direct
 *   - access_token expiré → refresh appelé + persist + envoi
 *   - refresh invalid_grant → mailSendNeedsReauth=true + mail_events row + throw
 *   - refresh autre erreur → mail_events row failed + throw provider_unreachable
 *   - gmail send échoue → mail_events row failed + throw
 *   - send OK → mail_events row 'sent' avec providerMessageId
 *   - buildMimeMessage : text-only
 *   - buildMimeMessage : html-only
 *   - buildMimeMessage : text + html (multipart/alternative)
 *   - buildMimeMessage : avec attachments (multipart/mixed)
 *   - buildMimeMessage : throw si ni text ni html
 *   - buildMimeMessage : subject ASCII inchangé, subject non-ASCII encodé
 *   - base64UrlEncode : URL-safe + no padding
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  sendGmailAsUser,
  buildMimeMessage,
  base64UrlEncode,
  MailUserNotFoundError,
  MailProviderNotLinkedError,
  MailNeedsReauthError,
  MailProviderUnreachableError,
  type GmailClientLike,
} from '@/lib/mail/send-gmail';

type AccountRow = {
  id: string;
  userId: string;
  provider: string;
  refresh_token: string | null;
  access_token: string | null;
  expires_at: number | null;
  mailSendScope: string | null;
  mailSendNeedsReauth: boolean;
};

type MailEventRow = {
  id: string;
  userId: string;
  appSource: string;
  provider: string;
  recipient: string;
  subject: string;
  providerMessageId: string | null;
  status: string;
  errorMessage: string | null;
  idempotencyKey: string;
  sentAt: Date;
};

function makeFakePrisma(seed: {
  users?: { id: string; email: string }[];
  accounts?: AccountRow[];
  mailEvents?: MailEventRow[];
}) {
  const users = [...(seed.users ?? [])];
  const accounts = [...(seed.accounts ?? [])];
  const mailEvents = [...(seed.mailEvents ?? [])];

  let nextEventId = 1;

  return {
    __users: users,
    __accounts: accounts,
    __mailEvents: mailEvents,
    user: {
      findUnique: async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
    },
    account: {
      findUnique: async ({ where }: any) =>
        accounts.find((a) => a.id === where.id) ?? null,
      findMany: async ({ where }: any) => {
        return accounts.filter(
          (a) =>
            a.userId === where.userId &&
            a.provider === where.provider &&
            (where.mailSendNeedsReauth === undefined ||
              a.mailSendNeedsReauth === where.mailSendNeedsReauth),
        );
      },
      update: async ({ where, data }: any) => {
        const row = accounts.find((a) => a.id === where.id);
        if (!row) throw new Error('account not found');
        Object.assign(row, data);
        return row;
      },
    },
    mailEvent: {
      findUnique: async ({ where }: any) =>
        mailEvents.find((m) => m.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: any) => {
        const row: MailEventRow = {
          id: `evt_${nextEventId++}`,
          userId: data.userId,
          appSource: data.appSource,
          provider: data.provider,
          recipient: data.recipient,
          subject: data.subject,
          providerMessageId: data.providerMessageId ?? null,
          status: data.status,
          errorMessage: data.errorMessage ?? null,
          idempotencyKey: data.idempotencyKey,
          sentAt: new Date(),
        };
        mailEvents.push(row);
        return row;
      },
    },
  };
}

function makeGmailClientOk(messageId: string): GmailClientLike {
  return {
    send: async () => ({
      data: { id: messageId },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
      request: {} as any,
    }),
  } as unknown as GmailClientLike;
}

const USER_ID = 'user_cuid_alice';
const SCOPE_OK = 'openid email profile https://www.googleapis.com/auth/gmail.send';

function baseSeed() {
  return {
    users: [{ id: USER_ID, email: 'alice@example.com' }],
    accounts: [
      {
        id: 'acc_google_alice',
        userId: USER_ID,
        provider: 'google',
        refresh_token: 'refresh_alice',
        access_token: 'access_alice',
        // Token valide : expire dans 1h
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        mailSendScope: SCOPE_OK,
        mailSendNeedsReauth: false,
      },
    ],
  };
}

const params = (over: Partial<Parameters<typeof sendGmailAsUser>[1]> = {}) => ({
  to: 'bob@example.com',
  subject: 'Hello',
  body_text: 'World',
  appSource: 'hub-test' as const,
  idempotencyKey: 'idem-1',
  ...over,
});

describe('sendGmailAsUser — idempotence', () => {
  it('returns idempotent_replay when previous send was successful', async () => {
    const fake = makeFakePrisma({
      ...baseSeed(),
      mailEvents: [
        {
          id: 'evt_old',
          userId: USER_ID,
          appSource: 'hub-test',
          provider: 'google',
          recipient: 'bob@example.com',
          subject: 'Hello',
          providerMessageId: 'gmail_msg_42',
          status: 'sent',
          errorMessage: null,
          idempotencyKey: 'idem-replay',
          sentAt: new Date('2026-05-25T10:00:00Z'),
        },
      ],
    });

    const result = await sendGmailAsUser(
      USER_ID,
      params({ idempotencyKey: 'idem-replay' }),
      { prisma: fake as any, buildGmailClient: () => makeGmailClientOk('NEVER') },
    );

    expect(result.idempotentReplay).toBe(true);
    expect(result.messageId).toBe('gmail_msg_42');
    expect(fake.__mailEvents.length).toBe(1); // pas de nouvelle row
  });

  it('rejects when idempotency_key was used by a failed send', async () => {
    const fake = makeFakePrisma({
      ...baseSeed(),
      mailEvents: [
        {
          id: 'evt_old',
          userId: USER_ID,
          appSource: 'hub-test',
          provider: 'google',
          recipient: 'bob@example.com',
          subject: 'Hello',
          providerMessageId: null,
          status: 'failed',
          errorMessage: 'previous fail',
          idempotencyKey: 'idem-failed',
          sentAt: new Date(),
        },
      ],
    });

    await expect(
      sendGmailAsUser(
        USER_ID,
        params({ idempotencyKey: 'idem-failed' }),
        { prisma: fake as any },
      ),
    ).rejects.toBeInstanceOf(MailProviderUnreachableError);
  });
});

describe('sendGmailAsUser — lookup user & account', () => {
  it('throws MailUserNotFoundError if user does not exist', async () => {
    const fake = makeFakePrisma({ users: [], accounts: [] });
    await expect(
      sendGmailAsUser('user_ghost', params(), { prisma: fake as any }),
    ).rejects.toBeInstanceOf(MailUserNotFoundError);
  });

  it('throws MailProviderNotLinkedError if no google account with gmail.send', async () => {
    const fake = makeFakePrisma({
      users: [{ id: USER_ID, email: 'alice@example.com' }],
      accounts: [
        {
          id: 'acc_google_basic',
          userId: USER_ID,
          provider: 'google',
          refresh_token: 'r',
          access_token: 'a',
          expires_at: 999,
          mailSendScope: 'openid email profile', // pas gmail.send
          mailSendNeedsReauth: false,
        },
      ],
    });
    await expect(
      sendGmailAsUser(USER_ID, params(), { prisma: fake as any }),
    ).rejects.toBeInstanceOf(MailProviderNotLinkedError);
  });

  it('throws MailProviderNotLinkedError if account exists but no refresh_token', async () => {
    const seed = baseSeed();
    seed.accounts[0].refresh_token = null;
    const fake = makeFakePrisma(seed);
    await expect(
      sendGmailAsUser(USER_ID, params(), { prisma: fake as any }),
    ).rejects.toBeInstanceOf(MailProviderNotLinkedError);
  });
});

describe('sendGmailAsUser — refresh logic', () => {
  it('does not refresh when access_token is still valid', async () => {
    const fake = makeFakePrisma(baseSeed());
    let refreshCalled = false;

    await sendGmailAsUser(USER_ID, params(), {
      prisma: fake as any,
      refreshAccessToken: async () => {
        refreshCalled = true;
        return { access_token: 'new', expires_at: Date.now() + 3600_000 };
      },
      buildGmailClient: () => makeGmailClientOk('gmail_msg_123'),
    });

    expect(refreshCalled).toBe(false);
  });

  it('refreshes when access_token is expired and persists new token', async () => {
    const seed = baseSeed();
    seed.accounts[0].expires_at = Math.floor(Date.now() / 1000) - 10; // expiré
    const fake = makeFakePrisma(seed);

    await sendGmailAsUser(USER_ID, params(), {
      prisma: fake as any,
      refreshAccessToken: async () => ({
        access_token: 'fresh_access',
        expires_at: Date.now() + 3600_000,
      }),
      buildGmailClient: () => makeGmailClientOk('gmail_msg_after_refresh'),
    });

    expect(fake.__accounts[0].access_token).toBe('fresh_access');
    expect(fake.__accounts[0].expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('sets mailSendNeedsReauth=true and throws on invalid_grant', async () => {
    const seed = baseSeed();
    seed.accounts[0].expires_at = 0; // force refresh
    const fake = makeFakePrisma(seed);

    await expect(
      sendGmailAsUser(USER_ID, params({ idempotencyKey: 'k-invgrant' }), {
        prisma: fake as any,
        refreshAccessToken: async () => {
          throw new Error('invalid_grant: Token has been expired or revoked.');
        },
      }),
    ).rejects.toBeInstanceOf(MailNeedsReauthError);

    expect(fake.__accounts[0].mailSendNeedsReauth).toBe(true);
    const row = fake.__mailEvents.find((m) => m.idempotencyKey === 'k-invgrant');
    expect(row?.status).toBe('needs_reauth');
  });

  it('persists failed mail_event when refresh fails with other error', async () => {
    const seed = baseSeed();
    seed.accounts[0].expires_at = 0;
    const fake = makeFakePrisma(seed);

    await expect(
      sendGmailAsUser(USER_ID, params({ idempotencyKey: 'k-netfail' }), {
        prisma: fake as any,
        refreshAccessToken: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toBeInstanceOf(MailProviderUnreachableError);

    expect(fake.__accounts[0].mailSendNeedsReauth).toBe(false);
    const row = fake.__mailEvents.find((m) => m.idempotencyKey === 'k-netfail');
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('refresh_failed');
  });
});

describe('sendGmailAsUser — gmail API', () => {
  it('persists sent event with providerMessageId on success', async () => {
    const fake = makeFakePrisma(baseSeed());

    const result = await sendGmailAsUser(USER_ID, params({ idempotencyKey: 'k-ok' }), {
      prisma: fake as any,
      buildGmailClient: () => makeGmailClientOk('gmail_xyz_999'),
    });

    expect(result.messageId).toBe('gmail_xyz_999');
    const row = fake.__mailEvents.find((m) => m.idempotencyKey === 'k-ok');
    expect(row?.status).toBe('sent');
    expect(row?.providerMessageId).toBe('gmail_xyz_999');
    expect(row?.appSource).toBe('hub-test');
    expect(row?.recipient).toBe('bob@example.com');
  });

  it('persists failed event when gmail.send throws', async () => {
    const fake = makeFakePrisma(baseSeed());

    await expect(
      sendGmailAsUser(USER_ID, params({ idempotencyKey: 'k-gfail' }), {
        prisma: fake as any,
        buildGmailClient: () => ({
          send: async () => {
            throw new Error('Quota exceeded');
          },
        }) as unknown as GmailClientLike,
      }),
    ).rejects.toBeInstanceOf(MailProviderUnreachableError);

    const row = fake.__mailEvents.find((m) => m.idempotencyKey === 'k-gfail');
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('Quota exceeded');
  });
});

describe('buildMimeMessage', () => {
  const base = {
    from: 'alice@example.com',
    to: ['bob@example.com'],
    subject: 'Hello',
  };

  it('text-only produces simple text/plain', () => {
    const mime = buildMimeMessage({ ...base, body_text: 'plain text body' });
    expect(mime).toContain('From: alice@example.com');
    expect(mime).toContain('To: bob@example.com');
    expect(mime).toContain('Subject: Hello');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('plain text body');
    expect(mime).not.toContain('multipart');
  });

  it('html-only produces multipart/alternative with html part', () => {
    const mime = buildMimeMessage({
      ...base,
      body_html: '<p>html body</p>',
      boundary: 'fixedbnd',
    });
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
    expect(mime).toContain('<p>html body</p>');
  });

  it('text + html produces both parts within multipart/alternative', () => {
    const mime = buildMimeMessage({
      ...base,
      body_text: 'plain',
      body_html: '<p>html</p>',
      boundary: 'bnd1',
    });
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
    expect(mime).toContain('plain');
    expect(mime).toContain('<p>html</p>');
  });

  it('attachments wrap content in multipart/mixed', () => {
    const mime = buildMimeMessage({
      ...base,
      body_text: 'plain',
      attachments: [
        {
          filename: 'doc.pdf',
          content_base64: 'JVBERi0xLjQK',
          mime_type: 'application/pdf',
        },
      ],
      boundary: 'bnd2',
    });
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('Content-Disposition: attachment; filename="doc.pdf"');
    expect(mime).toContain('Content-Type: application/pdf');
    expect(mime).toContain('JVBERi0xLjQK');
  });

  it('cc, bcc, reply_to are emitted', () => {
    const mime = buildMimeMessage({
      ...base,
      body_text: 'p',
      cc: ['c1@x.com', 'c2@x.com'],
      bcc: ['b1@x.com'],
      reply_to: 'r@x.com',
    });
    expect(mime).toContain('Cc: c1@x.com, c2@x.com');
    expect(mime).toContain('Bcc: b1@x.com');
    expect(mime).toContain('Reply-To: r@x.com');
  });

  it('throws if neither text nor html provided', () => {
    expect(() => buildMimeMessage({ ...base })).toThrowError(/body_text or body_html/);
  });

  it('encodes non-ASCII subject as RFC 2047', () => {
    const mime = buildMimeMessage({
      ...base,
      subject: 'Bonjour à vous',
      body_text: 'x',
    });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[^?]+\?=/);
  });

  it('keeps ASCII subject as-is', () => {
    const mime = buildMimeMessage({ ...base, subject: 'Plain ASCII', body_text: 'x' });
    expect(mime).toContain('Subject: Plain ASCII');
  });
});

describe('base64UrlEncode', () => {
  it('produces URL-safe characters only and no padding', () => {
    const out = base64UrlEncode('hello world?');
    expect(out).not.toMatch(/[+/=]/);
  });

  it('round-trips back to original via base64url decode', () => {
    const out = base64UrlEncode('subject:hello\r\nbody');
    const back = Buffer.from(out, 'base64url').toString('utf-8');
    expect(back).toBe('subject:hello\r\nbody');
  });
});

// ─── v1.1 — multi-comptes (mailAccountId) ──────────────────────────────────

describe('sendGmailAsUser — v1.1 mailAccountId resolution', () => {
  const USER_ID_V11 = 'user_v11';
  const SCOPE_OK_V11 = 'openid email profile https://www.googleapis.com/auth/gmail.send';

  it('returns mailAccountIdUsed = resolved Account.id (no mailAccountId)', async () => {
    const fake = makeFakePrisma({
      users: [{ id: USER_ID_V11, email: 'v11@example.com' }],
      accounts: [
        {
          id: 'acc_default_v11',
          userId: USER_ID_V11,
          provider: 'google',
          refresh_token: 'rt',
          access_token: 'at',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          mailSendScope: SCOPE_OK_V11,
          mailSendNeedsReauth: false,
        },
      ],
    });
    const result = await sendGmailAsUser(
      USER_ID_V11,
      {
        to: 'recip@example.com',
        subject: 'v1.1 default',
        body_text: 'hello',
        appSource: 'hub-test',
        idempotencyKey: 'idem-v11-1',
      },
      { prisma: fake as any, buildGmailClient: () => makeGmailClientOk('msg_v11') },
    );
    expect(result.messageId).toBe('msg_v11');
    expect(result.mailAccountIdUsed).toBe('acc_default_v11');
  });

  it('uses explicit mailAccountId when provided + valid for user', async () => {
    const fake = makeFakePrisma({
      users: [{ id: USER_ID_V11, email: 'v11@example.com' }],
      accounts: [
        {
          id: 'acc_perso',
          userId: USER_ID_V11,
          provider: 'google',
          refresh_token: 'rt',
          access_token: 'at',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          mailSendScope: SCOPE_OK_V11,
          mailSendNeedsReauth: false,
        },
        {
          id: 'acc_pro',
          userId: USER_ID_V11,
          provider: 'google',
          refresh_token: 'rt2',
          access_token: 'at2',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          mailSendScope: SCOPE_OK_V11,
          mailSendNeedsReauth: false,
        },
      ],
    });
    const result = await sendGmailAsUser(
      USER_ID_V11,
      {
        to: 'recip@example.com',
        subject: 'v1.1 explicit',
        body_text: 'hello',
        appSource: 'hub-test',
        idempotencyKey: 'idem-v11-2',
        mailAccountId: 'acc_pro',
      },
      { prisma: fake as any, buildGmailClient: () => makeGmailClientOk('msg_pro') },
    );
    expect(result.mailAccountIdUsed).toBe('acc_pro');
  });
});

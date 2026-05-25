/**
 * Tests /api/gmail/test-send — déclenche un mail de test pour le user loggué.
 *
 * Couvre :
 *   - 401 sans session
 *   - 200 quand send OK
 *   - 422 provider_not_linked
 *   - 412 needs_reauth
 *   - 503 provider_unreachable
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionUser = {
  id: 'cuid_user',
  email: 'alice@example.com',
  name: null,
  image: null,
  supabaseUserId: null,
};
const getCurrentUserMock = vi.fn();
vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const sendGmailMock = vi.fn();
vi.mock('@/lib/mail/send-gmail', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mail/send-gmail')>(
    '@/lib/mail/send-gmail',
  );
  return {
    ...actual,
    sendGmailAsUser: (...args: unknown[]) =>
      sendGmailMock(...(args as [string, unknown])),
  };
});

import {
  MailProviderNotLinkedError,
  MailNeedsReauthError,
  MailProviderUnreachableError,
} from '@/lib/mail/send-gmail';

beforeEach(() => {
  vi.resetModules();
  getCurrentUserMock.mockReset();
  sendGmailMock.mockReset();
});

async function callRoute() {
  const route = await import('@/app/api/gmail/test-send/route');
  return route.POST();
}

describe('POST /api/gmail/test-send', () => {
  it('returns 401 without session', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it('returns 200 with message_id on success', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_test_123',
      sentAt: new Date('2026-05-25T10:00:00Z'),
    });
    const res = await callRoute();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message_id).toBe('gmail_test_123');
    expect(json.sent_at).toBe('2026-05-25T10:00:00.000Z');

    expect(sendGmailMock).toHaveBeenCalledOnce();
    const [userId, params] = sendGmailMock.mock.calls[0];
    expect(userId).toBe('cuid_user');
    expect(params.to).toBe('alice@example.com');
    expect(params.appSource).toBe('hub-test');
    expect(params.idempotencyKey).toBeDefined();
  });

  it('returns 422 provider_not_linked', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    sendGmailMock.mockRejectedValueOnce(new MailProviderNotLinkedError('x'));
    const res = await callRoute();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('provider_not_linked');
  });

  it('returns 412 needs_reauth', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    sendGmailMock.mockRejectedValueOnce(new MailNeedsReauthError('x'));
    const res = await callRoute();
    expect(res.status).toBe(412);
    expect((await res.json()).error).toBe('needs_reauth');
  });

  it('returns 503 provider_unreachable', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    sendGmailMock.mockRejectedValueOnce(new MailProviderUnreachableError('down'));
    const res = await callRoute();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('provider_unreachable');
  });
});

// Tests unitaires pour lib/notifications/telegram.ts
//
// La fonction sendTelegramAlert est best-effort : elle ne doit JAMAIS throw,
// elle retourne true/false. On mocke fetch via TelegramOptions.fetchImpl pour
// éviter tout appel réseau réel et asserter sur les arguments passés.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTelegramAlert } from '@/lib/notifications/telegram';

describe('sendTelegramAlert', () => {
  const ORIGINAL_ENV = { ...process.env };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  describe('ENV missing', () => {
    it('returns false when botToken is missing (no fetch call)', async () => {
      const fetchImpl = vi.fn();
      const result = await sendTelegramAlert('hello', {
        chatId: '123',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when chatId is missing (no fetch call)', async () => {
      const fetchImpl = vi.fn();
      const result = await sendTelegramAlert('hello', {
        botToken: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns false when both are missing (env vars not set)', async () => {
      const fetchImpl = vi.fn();
      const result = await sendTelegramAlert('hello', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reads botToken/chatId from process.env when not passed in opts', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token';
      process.env.TELEGRAM_CHAT_ID = 'env-chat';
      const fetchImpl = vi.fn(async () =>
        new Response('{"ok":true}', { status: 200 }),
      );

      const result = await sendTelegramAlert('hello', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl] = fetchImpl.mock.calls[0];
      expect(calledUrl).toBe('https://api.telegram.org/botenv-token/sendMessage');
    });
  });

  describe('Telegram 200 (success)', () => {
    it('returns true and calls fetch once with correct URL + payload', async () => {
      const fetchImpl = vi.fn(async () =>
        new Response('{"ok":true}', { status: 200 }),
      );

      const result = await sendTelegramAlert('hello world', {
        botToken: 'tok123',
        chatId: 'chat456',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/bottok123/sendMessage');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        chat_id: 'chat456',
        text: 'hello world',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      expect(init.signal).toBeDefined();
    });
  });

  describe('Telegram 5xx (retry path)', () => {
    it('retries once on 500 then returns true if 2nd call succeeds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('returns false after two consecutive 500 responses', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(new Response('still boom', { status: 503 }));

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('Telegram 4xx (no retry)', () => {
    it('returns false immediately on 400 without retrying', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('bad request', { status: 400 }));

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns false immediately on 401 without retrying', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('AbortController timeout', () => {
    it('returns false when fetch is aborted (timeout fires)', async () => {
      // fetchImpl simule un fetch qui rejette avec AbortError quand le signal abort
      const fetchImpl = vi.fn((url: any, init: any) => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        timeoutMs: 10,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      // Le code retry une fois sur error → 2 calls
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('Network errors', () => {
    it('returns false when fetch throws once then throws again (retry exhausted)', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ENETUNREACH'));

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns true when fetch throws once then succeeds on retry', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('handles non-Error throws (string) without throwing itself', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce('weird string')
        .mockRejectedValueOnce('still weird');

      const result = await sendTelegramAlert('msg', {
        botToken: 'tok',
        chatId: 'chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBe(false);
    });

    it('never throws even when fetch rejects on both attempts', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValue(new Error('boom'));

      await expect(
        sendTelegramAlert('msg', {
          botToken: 'tok',
          chatId: 'chat',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).resolves.toBe(false);
    });
  });
});

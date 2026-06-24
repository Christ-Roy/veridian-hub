/**
 * Tests de l'envoi d'emails transactionnels (lib/email/send.ts).
 *
 * Couvre les 3 chemins de sendMail : Brevo (API HTTP, prioritaire si
 * BREVO_API_KEY), fallback SMTP (nodemailer createTransport), et l'erreur si
 * aucun provider n'est configuré. Le test du chemin SMTP verrouille AUSSI le
 * bump nodemailer v8→v9 (CVE GHSA-p6gq-j5cr-w38f) : l'import nommé
 * `{ createTransport }` doit fonctionner et sendMail être appelé.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock nodemailer : createTransport renvoie un transporter dont sendMail est
// observable. Vérifie que le bump v9 (import nommé) reste fonctionnel.
const sendMailInner = vi.fn().mockResolvedValue({ messageId: 'm1' });
const createTransportMock = vi.fn().mockReturnValue({ sendMail: sendMailInner });
vi.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => createTransportMock(...args),
}));

import { sendMail } from '@/lib/email/send';

const PAYLOAD = {
  to: 'dest@example.com',
  subject: 'Sujet',
  html: '<p>Bonjour</p>',
};

const ENV_KEYS = [
  'BREVO_API_KEY',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_PORT',
];

let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  sendMailInner.mockClear();
  createTransportMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe('sendMail — chemin Brevo (prioritaire)', () => {
  it('POST l\'API Brevo avec la clé + le payload, n\'utilise PAS le SMTP', async () => {
    process.env.BREVO_API_KEY = 'brevo-key';
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));

    await sendMail(PAYLOAD);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('api.brevo.com');
    expect(opts.headers['api-key']).toBe('brevo-key');
    const body = JSON.parse(opts.body);
    expect(body.to).toEqual([{ email: 'dest@example.com' }]);
    expect(body.subject).toBe('Sujet');
    // Brevo prioritaire → pas de fallback SMTP.
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('throw si Brevo répond une erreur', async () => {
    process.env.BREVO_API_KEY = 'brevo-key';
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(sendMail(PAYLOAD)).rejects.toThrow(/Brevo API error 500/);
  });
});

describe('sendMail — fallback SMTP (nodemailer v9)', () => {
  it('createTransport + sendMail quand pas de clé Brevo mais SMTP configuré', async () => {
    process.env.SMTP_HOST = 'smtp.lark.test';
    process.env.SMTP_USER = 'user@veridian.site';
    process.env.SMTP_PASSWORD = 'secret';

    await sendMail(PAYLOAD);

    // Le bump nodemailer v9 (import nommé) fonctionne : transport créé + envoyé.
    expect(createTransportMock).toHaveBeenCalledOnce();
    const cfg = createTransportMock.mock.calls[0][0];
    expect(cfg.host).toBe('smtp.lark.test');
    expect(cfg.auth.user).toBe('user@veridian.site');
    expect(sendMailInner).toHaveBeenCalledOnce();
    const mail = sendMailInner.mock.calls[0][0];
    expect(mail.to).toBe('dest@example.com');
    expect(mail.subject).toBe('Sujet');
    // fetch (Brevo) PAS appelé.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendMail — aucun provider configuré', () => {
  it('throw une erreur explicite si ni Brevo ni SMTP', async () => {
    await expect(sendMail(PAYLOAD)).rejects.toThrow(
      /Email provider non configuré/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});

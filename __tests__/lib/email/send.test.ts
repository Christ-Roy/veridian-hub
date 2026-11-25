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

import { createHash } from 'node:crypto';

import { mailBloque, sendMail } from '@/lib/email/send';

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

describe('adresses bloquées', () => {
  const empreinte = (a: string) => createHash('sha256').update(a).digest('hex').slice(0, 16);

  it('reconnaît l\'adresse quelle que soit la casse, et personne d\'autre', () => {
    const env = { NODE_ENV: 'test', MAILS_BLOQUES_SHA256: ` ${empreinte('autre@example.com')}, ${empreinte('dest@example.com').toUpperCase()} ` } as NodeJS.ProcessEnv;
    expect(mailBloque(' Dest@Example.com ', env)).toBe(true);
    expect(mailBloque('dest2@example.com', env)).toBe(false);
    expect(mailBloque('dest@example.com', { NODE_ENV: 'test' })).toBe(false);
    expect(mailBloque('', { NODE_ENV: 'test', MAILS_BLOQUES_SHA256: 'x,' })).toBe(false);
    expect(mailBloque('dest@example.com', { NODE_ENV: 'test', MAILS_BLOQUES_SHA256: empreinte('dest@example.com').slice(0, 4) }), 'une empreinte trop courte ne bloque personne').toBe(false);
  });

  it('aucun fournisseur n\'est appelé pour elle ; les autres partent', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('BREVO_API_KEY', 'k');
    vi.stubEnv('MAILS_BLOQUES_SHA256', empreinte('dest@example.com'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await sendMail(PAYLOAD);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(info.mock.calls[0])).not.toContain('dest@example.com');
    await sendMail({ ...PAYLOAD, to: 'client@example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe('sendMail — comptes d\'épreuve (25/11 : 16 rebonds durs sur 64 envois)', () => {
  const corps = async (to: string) => {
    process.env.BREVO_API_KEY = 'brevo-key';
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    await sendMail({ ...PAYLOAD, to });
    return JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
  };
  it('part par le même chemin, en bac à sable', async () => {
    for (const to of ['e2e-sso-mwv1-adra@veridian.site', ' E2E-SSO-X@Veridian.Site ']) expect((await corps(to)).headers, to).toEqual({ 'X-Sib-Sandbox': 'drop' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('une vraie adresse n\'y va JAMAIS, même qui y ressemble', async () => {
    for (const to of ['client@exemple.fr', 'robert.brunon@veridian.site', 'r.brunon+e2e-sso@veridian.site', 'e2e-sso-x@client.fr', 'e2e-sso-x@veridian.site.client.fr', 'x-e2e-sso-x@veridian.site', 'e2e-sso-@veridian.site', 'e2e-sso-a b@veridian.site']) expect(await corps(to), to).not.toHaveProperty('headers');
  });
  it('le repli SMTP ne lui écrit pas ; à une vraie adresse, si', async () => {
    Object.assign(process.env, { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p' });
    await sendMail({ ...PAYLOAD, to: 'e2e-sso-x@veridian.site' });
    expect(sendMailInner).not.toHaveBeenCalled();
    await sendMail(PAYLOAD);
    expect(sendMailInner).toHaveBeenCalledTimes(1);
  });
});

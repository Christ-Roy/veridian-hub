/**
 * Preuve d'adresse : fournisseur OAuth, lien par mail lié à la session, annulation
 * d'un mot de passe posé à l'avance. Cf. lib/auth/email-proof.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/email/send', () => ({ sendMail: vi.fn() }));

import {
  applyProviderEmailProof,
  consumeEmailProof,
  EMAIL_PROOF_IDENTIFIER_PREFIX,
  issueEmailProof,
  providerProvesEmail,
} from '@/lib/auth/email-proof';

const EMAIL = 'test@veridian.site';

describe('providerProvesEmail', () => {
  it.each([
    ['google', { email: EMAIL, email_verified: true }, true],
    ['google', { email: 'TEST@veridian.site', email_verified: true }, true],
    ['google', { email: EMAIL, email_verified: false }, false],
    ['google', { email: 'autre@veridian.site', email_verified: true }, false],
    ['google', undefined, false],
    ['google-one-tap', undefined, true],
    ['credentials', { email: EMAIL, email_verified: true }, false],
    // Entra multi-tenant : l'email seul se falsifie (nOAuth).
    ['microsoft-entra-id', { email: EMAIL }, false],
    ['microsoft-entra-id', { email: EMAIL, email_verified: true }, false],
    ['microsoft-entra-id', { email: EMAIL, xms_edov: true }, true],
  ])('%s %j → %s', (provider, profile, expected) => {
    expect(providerProvesEmail({ provider }, profile, EMAIL)).toBe(expected);
  });
});

function fakePrisma(user: { emailVerified: Date | null; email?: string }, credentials = 0) {
  // L'adresse courante du compte : la preuve doit lui correspondre (D2). Muté en place par les tests.
  if (user.email === undefined) user.email = EMAIL;
  const tokens = new Map<string, { identifier: string; token: string; expires: Date }>();
  return {
    tokens,
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async () => user),
    },
    account: { deleteMany: vi.fn(async () => ({ count: credentials })) },
    verificationToken: {
      findFirst: vi.fn(async ({ where }: never) => {
        const w = where as { identifier: string; expires: { gt: Date } };
        return (
          [...tokens.values()].find(
            (t) => t.identifier === w.identifier && t.expires > w.expires.gt,
          ) ?? null
        );
      }),
      findUnique: vi.fn(async ({ where }: never) => tokens.get((where as { token: string }).token) ?? null),
      deleteMany: vi.fn(async ({ where }: never) => {
        const w = where as { identifier: string | { startsWith: string } };
        for (const [k, v] of tokens) {
          const hit =
            typeof w.identifier === 'string'
              ? v.identifier === w.identifier
              : v.identifier.startsWith(w.identifier.startsWith);
          if (hit) tokens.delete(k);
        }
        return { count: 1 };
      }),
      create: vi.fn(async ({ data }: never) => {
        const d = data as { identifier: string; token: string; expires: Date };
        tokens.set(d.token, d);
        return d;
      }),
    },
  };
}

describe('applyProviderEmailProof', () => {
  it('adresse non prouvée + mot de passe : annule le mot de passe et les sessions', async () => {
    const p = fakePrisma({ emailVerified: null }, 1);
    await applyProviderEmailProof(p as never, 'u1');
    expect(p.account.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', provider: 'credentials' },
    });
    const data = (p.user.update.mock.calls[0] as never as [{ data: Record<string, unknown> }])[0].data;
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(data.sessionsValidAfter).toBeInstanceOf(Date);
  });

  it('adresse non prouvée sans mot de passe : prouve, sans toucher aux sessions', async () => {
    const p = fakePrisma({ emailVerified: null }, 0);
    await applyProviderEmailProof(p as never, 'u1');
    const data = (p.user.update.mock.calls[0] as never as [{ data: Record<string, unknown> }])[0].data;
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(data.sessionsValidAfter).toBeUndefined();
  });

  it('adresse déjà prouvée : le mot de passe du client reste intact', async () => {
    const p = fakePrisma({ emailVerified: new Date() }, 1);
    await applyProviderEmailProof(p as never, 'u1');
    expect(p.account.deleteMany).not.toHaveBeenCalled();
    expect(p.user.update).not.toHaveBeenCalled();
  });
});

describe('lien de preuve par mail', () => {
  const user = { id: 'u1', email: EMAIL };
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn(async () => undefined);
  });

  const tokenFrom = (call: unknown[]) => {
    const html = (call[0] as { html: string }).html;
    return decodeURIComponent(/token=([^"&]+)/.exec(html)![1]);
  };

  it('envoie le lien et ne stocke que son empreinte', async () => {
    const p = fakePrisma({ emailVerified: null });
    expect(await issueEmailProof(p as never, user, send as never)).toBe(true);
    const token = tokenFrom(send.mock.calls[0]);
    expect(p.tokens.has(token)).toBe(false);
    // Le jeton porte le compte ET l'empreinte de l'adresse (D2).
    expect([...p.tokens.values()][0].identifier).toMatch(new RegExp(`^${EMAIL_PROOF_IDENTIFIER_PREFIX}u1:[0-9a-f]{64}$`));
  });

  it('ne bombarde pas : un second envoi immédiat ne part pas', async () => {
    const p = fakePrisma({ emailVerified: null });
    await issueEmailProof(p as never, user, send as never);
    expect(await issueEmailProof(p as never, user, send as never)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('prouve le compte de la session qui présente le lien', async () => {
    const p = fakePrisma({ emailVerified: null });
    await issueEmailProof(p as never, user, send as never);
    expect(await consumeEmailProof(p as never, tokenFrom(send.mock.calls[0]), 'u1')).toBe('proved');
    expect(p.user.update).toHaveBeenCalled();
  });

  it('une autre session (victime, scanner connecté ailleurs) ne prouve rien', async () => {
    const p = fakePrisma({ emailVerified: null });
    await issueEmailProof(p as never, user, send as never);
    expect(await consumeEmailProof(p as never, tokenFrom(send.mock.calls[0]), 'autre')).toBe(
      'wrong_account',
    );
    expect(p.user.update).not.toHaveBeenCalled();
  });

  it('refuse un jeton inconnu, et un jeton consommé', async () => {
    const p = fakePrisma({ emailVerified: null });
    await issueEmailProof(p as never, user, send as never);
    const token = tokenFrom(send.mock.calls[0]);
    expect(await consumeEmailProof(p as never, 'faux', 'u1')).toBe('invalid');
    await consumeEmailProof(p as never, token, 'u1');
    expect(await consumeEmailProof(p as never, token, 'u1')).toBe('invalid');
  });

  it('D2 : un jeton émis pour une ancienne adresse ne prouve pas la nouvelle', async () => {
    const account = { emailVerified: null as Date | null, email: 'a@evil.example' };
    const p = fakePrisma(account);
    await issueEmailProof(p as never, { id: 'u1', email: 'a@evil.example' }, send as never);
    const token = tokenFrom(send.mock.calls[0]);
    // PATCH profil : l'adresse change dans la même session, dans les 10 minutes.
    account.email = 'victime@corp.example';
    expect(await consumeEmailProof(p as never, token, 'u1')).toBe('invalid');
    expect(p.user.update).not.toHaveBeenCalled();
  });

  it('D2 : après un changement d\'adresse, le lien part tout de suite vers la nouvelle', async () => {
    const account = { emailVerified: null as Date | null, email: 'a@evil.example' };
    const p = fakePrisma(account);
    await issueEmailProof(p as never, { id: 'u1', email: 'a@evil.example' }, send as never);
    account.email = 'victime@corp.example';
    expect(
      await issueEmailProof(p as never, { id: 'u1', email: 'victime@corp.example' }, send as never),
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ to: 'victime@corp.example' });
  });

  it('refuse un jeton d\'impersonation réutilisé ici', async () => {
    const p = fakePrisma({ emailVerified: null });
    p.verificationToken.findUnique.mockResolvedValueOnce({
      identifier: 'impersonate:u1',
      expires: new Date(Date.now() + 1000),
    } as never);
    expect(await consumeEmailProof(p as never, 'x', 'u1')).toBe('invalid');
  });
});

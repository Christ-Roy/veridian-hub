// Reset password flow — MVP migration Auth.js v5.
//
// Cette route gère 2 cas :
// 1. POST avec { email } → génère un VerificationToken Prisma (TTL 1h),
//    envoie un mail Brevo avec lien `/auth/reset?token=...`
// 2. POST avec { token, password } → consomme le token, met à jour le hash
//    bcrypt dans Account.access_token (provider='credentials')
//
// Décision technique (LOT A migration) : flow MVP, pas de page custom pour la
// demande — le formulaire `/components/ui/AuthForms/ForgotPassword` postera
// ici. La page `/auth/reset` (qui consomme le token) est créée à part.
//
// Volontairement neutre sur les erreurs côté "demande de reset" : on ne
// révèle pas si l'email existe (anti-énumération).

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/email/send';
import { getURL } from '@/utils/helpers';

const requestSchema = z.object({
  email: z.string().email(),
});

const consumeSchema = z.object({
  token: z.string().min(16),
  password: z.string().min(8),
});

const RESET_TTL_MS = 60 * 60 * 1000; // 1h

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Cas 2 : consommation token
  const consume = consumeSchema.safeParse(payload);
  if (consume.success) {
    return handleConsume(consume.data);
  }

  // Cas 1 : demande de reset
  const req = requestSchema.safeParse(payload);
  if (req.success) {
    return handleRequest(req.data.email);
  }

  return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
}

async function handleRequest(emailRaw: string): Promise<NextResponse> {
  const email = emailRaw.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  // Anti-énumération : on retourne 200 même si l'user n'existe pas.
  if (!user) {
    return NextResponse.json({ ok: true });
  }

  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MS);

  // VerificationToken n'a pas d'unique sur identifier seul → on nettoie d'abord
  // les anciens tokens du même user pour éviter d'en accumuler.
  await prisma.verificationToken.deleteMany({
    where: { identifier: user.email },
  });

  await prisma.verificationToken.create({
    data: {
      identifier: user.email,
      token,
      expires,
    },
  });

  const resetUrl = `${getURL()}/auth/reset?token=${encodeURIComponent(token)}`;

  try {
    await sendMail({
      to: user.email,
      subject: 'Veridian — Réinitialisation du mot de passe',
      html: `
        <p>Bonjour,</p>
        <p>Une demande de réinitialisation de mot de passe a été effectuée pour votre compte Veridian.</p>
        <p><a href="${resetUrl}">Cliquez ici pour définir un nouveau mot de passe</a></p>
        <p>Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce mail.</p>
        <p>— L'équipe Veridian</p>
      `,
      text: `Réinitialisez votre mot de passe Veridian : ${resetUrl}\n\nValable 1 heure.`,
    });
  } catch (err) {
    console.error('[reset_password] Failed to send mail:', err);
    // On retourne quand même 200 pour ne pas leak l'existence du compte.
  }

  return NextResponse.json({ ok: true });
}

async function handleConsume(data: { token: string; password: string }): Promise<NextResponse> {
  const record = await prisma.verificationToken.findUnique({
    where: { token: data.token },
  });

  if (!record) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
  }

  if (record.expires < new Date()) {
    await prisma.verificationToken.delete({ where: { token: data.token } }).catch(() => {});
    return NextResponse.json({ error: 'Token expired' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email: record.identifier },
    include: { accounts: true },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const passwordHash = await bcrypt.hash(data.password, 10);

  // Trouver (ou créer) le compte credentials et update le hash.
  type AccountLike = typeof user.accounts[number];
  const credsAccount = user.accounts.find(
    (a: AccountLike) => a.provider === 'credentials'
  );

  if (credsAccount) {
    await prisma.account.update({
      where: { id: credsAccount.id },
      data: { access_token: passwordHash },
    });
  } else {
    // User Google-only qui veut ajouter un mot de passe : on crée le compte
    // credentials avec le hash.
    await prisma.account.create({
      data: {
        userId: user.id,
        type: 'credentials',
        provider: 'credentials',
        providerAccountId: user.email,
        access_token: passwordHash,
      },
    });
  }

  // Token consommé → suppression
  await prisma.verificationToken.delete({ where: { token: data.token } }).catch(() => {});

  return NextResponse.json({ ok: true });
}

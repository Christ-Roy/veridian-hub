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
//
// Rate-limit (2026-07-28) : la route était la seule route d'auth publique du
// Hub sans plafond, alors que chaque appel « demande » déclenche un envoi
// Brevo. Deux risques réels : mail-bombing d'un client visé, et cramage du
// quota transactionnel Brevo. Trois limiters, cf. commentaires ci-dessous.

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/email/send';
import { getURL } from '@/utils/helpers';
import { RateLimiter, extractClientIp } from '@/lib/auth/rate-limit';

const requestSchema = z.object({
  email: z.string().email(),
});

const consumeSchema = z.object({
  token: z.string().min(16),
  // max(72) : bcrypt tronque silencieusement à 72 bytes — au-delà n'apporte
  // rien et ouvre un DoS CPU (hash d'un payload XXL). Même borne que signup.
  password: z.string().min(8).max(72),
});

const RESET_TTL_MS = 60 * 60 * 1000; // 1h

// ─── Rate-limiters ──────────────────────────────────────────────────────────
//
// Les instances vivent ici (et non dans lib/auth/rate-limit.ts) : elles ne
// servent qu'à cette route, et le fichier partagé est en cours de modification
// par un autre chantier. Même pattern maison (`RateLimiter`, `extractClientIp`,
// `enforceWithBypass`), donc le bypass E2E staging fonctionne aussi ici.

// Plafond par IP sur la DEMANDE de reset. Fenêtre longue (15 min) volontaire :
// un plafond à la minute ne gêne pas un attaquant qui lisse son débit, alors
// que le coût réel (mail envoyé) se mesure à l'heure. 5/15 min laisse un humain
// se rater plusieurs fois — y compris un client en première connexion (cette
// route sert aussi de flow « je n'ai jamais eu de mot de passe »).
export const resetRequestIpLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 15 * 60_000,
  name: 'reset-password-request-ip',
});

// Plafond par EMAIL VISÉ. Indispensable : le mail-bombing d'une victime précise
// passe sous n'importe quel plafond purement IP dès que l'attaquant tourne
// (proxies, botnet). Ici la clé est la cible, pas la source → l'attaquant a
// beau changer d'IP, la boîte de la victime ne reçoit pas plus de 4 mails/h.
// 4/h reste large pour un légitime : le lien vaut 1 h, redemander plus de 4
// fois dans l'heure n'a aucun sens fonctionnel.
//
// Anti-énumération : ce limiter est appliqué AVANT le lookup user, donc il
// compte pareil pour un email inexistant. Un 429 ne dit jamais « ce compte
// existe », seulement « cet email a déjà été demandé récemment ».
export const resetRequestEmailLimiter = new RateLimiter({
  capacity: 4,
  windowMs: 60 * 60_000,
  name: 'reset-password-request-email',
});

// Plafond par IP sur la CONSOMMATION du token. Le token fait 32 bytes (~10^77),
// le brute-force est hors de portée, mais on plafonne le scan (bruit de logs +
// coût bcrypt par tentative). 10/min laisse un humain corriger sa saisie.
export const resetConsumeLimiter = new RateLimiter({
  capacity: 10,
  windowMs: 60_000,
  name: 'reset-password-consume',
});

function tooManyResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Trop de tentatives. Patientez avant de réessayer.',
      code: 'rate_limited',
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

function logRateLimit(tag: string, key: string, retryAfterSeconds: number) {
  console.warn(
    JSON.stringify({
      tag,
      level: 'warn',
      key,
      retry_after_s: retryAfterSeconds,
      ts: new Date().toISOString(),
    })
  );
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const ip = extractClientIp(request.headers);

  // Cas 2 : consommation token
  const consume = consumeSchema.safeParse(payload);
  if (consume.success) {
    const rate = resetConsumeLimiter.enforceWithBypass(ip, request.headers);
    if (!rate.ok) {
      logRateLimit('[reset-password-consume-ratelimit]', ip, rate.retryAfterSeconds);
      return tooManyResponse(rate.retryAfterSeconds);
    }
    return handleConsume(consume.data);
  }

  // Cas 1 : demande de reset
  const req = requestSchema.safeParse(payload);
  if (req.success) {
    const email = req.data.email.toLowerCase().trim();

    // IP d'abord (frein anti-flood générique), puis email visé (anti
    // mail-bombing d'une cible). Les deux comptent la tentative même refusée.
    const ipRate = resetRequestIpLimiter.enforceWithBypass(ip, request.headers);
    if (!ipRate.ok) {
      logRateLimit('[reset-password-request-ratelimit]', ip, ipRate.retryAfterSeconds);
      return tooManyResponse(ipRate.retryAfterSeconds);
    }

    const emailRate = resetRequestEmailLimiter.enforceWithBypass(email, request.headers);
    if (!emailRate.ok) {
      logRateLimit('[reset-password-request-ratelimit]', email, emailRate.retryAfterSeconds);
      return tooManyResponse(emailRate.retryAfterSeconds);
    }

    return handleRequest(email);
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

  // Envoi NON awaité, volontairement.
  //
  // L'anti-énumération annoncée en tête de fichier était incomplète : un email
  // inexistant répondait 200 en quelques ms, un email existant attendait l'appel
  // HTTP Brevo (~centaines de ms). Cet écart, mesurable au chrono, révélait
  // l'existence du compte aussi sûrement qu'un message d'erreur explicite.
  // En détachant l'envoi, les deux branches répondent au même coût (un lookup
  // + les écritures token). Le Hub tourne en process Node long (pas de
  // fonction serverless coupée après la réponse) → la promesse va au bout.
  void sendMail({
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
  }).catch((err) => {
    // Catch obligatoire : sans lui, un échec Brevo devient une unhandled
    // rejection qui peut tuer le process Node.
    console.error('[reset_password] Failed to send mail:', err);
  });

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

// POST /api/auth/signup — création d'un user + Account credentials.
//
// Auth.js v5 ne fournit pas de signup natif pour CredentialsProvider, donc on
// gère la création nous-mêmes :
// 1. Hash bcrypt du password (stocké UNIQUEMENT côté Hub — les apps downstream
//    sont magic-link only, jamais de password partagé)
// 2. Création User + Account (provider='credentials', access_token=hash)
// 3. supabaseUserId = randomUUID() pour cohérence avec les users migrés
//    (ces ID servent de pont vers tenants.user_id et subscriptions.user_id qui
//    sont en UUID).
// 4. Provision workspace par défaut + WorkspaceMember role=OWNER (décision
//    Robert 2026-05-21 option 1 : auto-création silencieuse mono-workspace
//    pattern Linear/Notion/Slack). Best-effort : un échec ne casse pas le
//    signup, le backfill prod rattrapera.
//
// Plus de provisioning automatique des tenants ici : le user atterrit sur
// /dashboard et clique "Commencer l'essai" par app (POST /api/tenants/start).
// Ça permet de tester une seule app sans engager les autres.

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { PASSWORD_MAX, PASSWORD_MIN } from '@/lib/auth/password-policy';
import { issueEmailProof } from '@/lib/auth/email-proof';
import { prisma } from '@/lib/prisma';
import { signupLimiter, extractClientIp } from '@/lib/auth/rate-limit';
import { SIGNUP_HONEYPOT_FIELD } from '@/lib/auth/signup-honeypot';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';
import { trackGoal, hubSessionId } from '@/lib/analytics/track-event';

const signupSchema = z.object({
  email: z.string().email(),
  // max(72) : bcrypt tronque silencieusement à 72 bytes — au-delà n'ajoute
  // aucune sécurité et expose à un DoS (hash CPU + stockage sur payload XXL,
  // ex. password 2 MB). Borne explicite côté Zod → 400 avant tout hash.
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
});

export async function POST(request: NextRequest) {
  // Anti-DoS : 5 signups/min/IP. Au-delà → 429 + Retry-After.
  //
  // `enforceWithBypass` : laisse passer si le header E2E
  // `x-veridian-e2e-bypass-ratelimit` est valide ET DEPLOY_ENV !== 'prod'.
  // En prod, le bypass est court-circuité par `shouldBypassRateLimit`
  // (cf. lib/auth/rate-limit.ts) → comportement strictement identique
  // au code legacy `enforce(ip)`.
  const ip = extractClientIp(request.headers);
  const rate = signupLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) {
    console.warn(
      JSON.stringify({
        tag: '[signup-ratelimit]',
        level: 'warn',
        ip,
        retry_after_s: rate.retryAfterSeconds,
        ts: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      { error: 'rate_limited', message: 'Trop de tentatives. Patientez avant de réessayer.' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Piège à robots : un champ invisible qu'aucun humain ne remplit. Refus franc plutôt que faux
  // succès : si un gestionnaire de mots de passe le remplissait, la personne doit le savoir.
  if ((payload as { [SIGNUP_HONEYPOT_FIELD]?: unknown } | null)?.[SIGNUP_HONEYPOT_FIELD]) {
    console.warn(JSON.stringify({ tag: '[signup-honeypot]', level: 'warn', ip, ts: new Date().toISOString() }));
    return NextResponse.json(
      { error: 'Inscription impossible. Rechargez la page et réessayez.' },
      { status: 400 },
    );
  }

  const parsed = signupSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Adresse email ou mot de passe invalide (mot de passe : 8 à 72 caractères).' },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Vérifier qu'on ne crée pas un doublon
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: 'An account with this email already exists' },
      { status: 409 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // UUID stringifié — sert de pont vers tenants.user_id (UUID) /
  // subscriptions.user_id (UUID). Pour les users migrés c'est l'ID Supabase
  // originel ; pour les nouveaux c'est un UUID v4 frais.
  const userUuid = randomUUID();

  try {
    const user = await prisma.user.create({
      data: {
        id: userUuid,
        email: normalizedEmail,
        supabaseUserId: userUuid,
        accounts: {
          create: {
            type: 'credentials',
            provider: 'credentials',
            providerAccountId: normalizedEmail,
            access_token: passwordHash,
          },
        },
      },
      select: { id: true, email: true, name: true },
    });

    // Provision workspace par défaut (best-effort — un échec ne doit pas
    // bloquer le signup, le backfill prod rattrapera les éventuels orphelins).
    try {
      await provisionDefaultWorkspace(
        { userId: user.id, email: user.email, name: user.name },
        { prisma, actor: 'system:credentials-signup' }
      );
    } catch (wsErr) {
      console.error('[Signup] workspace provisioning failed (non-blocking):', wsErr);
    }

    // Lien de preuve dès l'inscription : sans lui, aucun outil ne s'ouvre.
    void issueEmailProof(prisma, { id: user.id, email: user.email }).catch((err) => {
      console.error('[Signup] email proof failed (non-blocking):', err);
    });

    // Tunnel de vente : goal `signup` vers Veridian Analytics (best-effort,
    // fire-and-forget). user_id = email → le bridge fait l'union slug↔email.
    // Volontairement NON awaité : un échec analytics ne casse jamais le signup.
    void trackGoal({
      userEmail: user.email,
      goal: 'signup',
      sessionId: hubSessionId(userUuid),
      properties: { provider: 'credentials' },
    });

    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (err: any) {
    console.error('[Signup] Failed to create user:', err);
    return NextResponse.json(
      { error: 'Failed to create account' },
      { status: 500 }
    );
  }
}

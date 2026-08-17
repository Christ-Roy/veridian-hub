import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { extractClientIp, onboardingQualificationLimiter } from '@/lib/auth/rate-limit';
import {
  getUserOnboardingRecord,
  saveOnboardingQualification,
} from '@/lib/onboarding/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const qualificationSchema = z.object({
  siteActuel: z.enum(['oui', 'non']).optional(),
  intentionSiteExistant: z.enum(['satisfait', 'refonte', 'application']).optional(),
  intentionSansSite: z.enum(['vitrine', 'boutique', 'application', 'indecis']).optional(),
  emailing: z.enum(['liste-existante', 'depuis-zero', 'plus-tard']).optional(),
  prospection: z.enum(['priorite', 'explorer', 'b2c', 'plus-tard']).optional(),
  echeance: z.enum(['urgent', 'trimestre', 'sans-date']).optional(),
}).strict();

const etapeCouranteSchema = z.enum([
  'accueil',
  'site-actuel',
  'site-intention-existant',
  'site-intention-creation',
  'emailing',
  'prospection',
  'echeance',
  'recapitulatif',
]);

const bodySchema = z.object({
  qualification: qualificationSchema,
  etapeCourante: etapeCouranteSchema.optional(),
  completed: z.boolean().optional(),
});

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'rate_limited', message: 'Trop de tentatives. Patientez avant de réessayer.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export async function POST(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ip = extractClientIp(request.headers);
  const rate = onboardingQualificationLimiter.enforceWithBypass(`${userId}:${ip}`, request.headers);
  if (!rate.ok) return rateLimited(rate.retryAfterSeconds);

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const record = await saveOnboardingQualification(prisma, {
    userId,
    qualification: parsed.data.qualification,
    etapeCourante: parsed.data.etapeCourante,
    completed: parsed.data.completed,
  });

  return NextResponse.json({ ok: true, onboarding: record });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ip = extractClientIp(request.headers);
  const rate = onboardingQualificationLimiter.enforceWithBypass(`${userId}:${ip}`, request.headers);
  if (!rate.ok) return rateLimited(rate.retryAfterSeconds);

  const record = await getUserOnboardingRecord(prisma, userId);
  return NextResponse.json({ ok: true, onboarding: record });
}

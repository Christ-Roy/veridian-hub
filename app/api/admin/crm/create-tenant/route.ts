/**
 * POST /api/admin/crm/create-tenant
 *
 * Provisionne un workspace Veridian CRM (Twenty fork) pour un user Hub
 * existant et stocke le Bearer Twenty + password (chiffrés AES-256-GCM)
 * côté Hub. Retourne un magic link valide 15 min.
 *
 * Spec : ticket `todo/2026-05-27-route-admin-create-crm-tenant.md`.
 *
 * Idempotence :
 *  - Si un crm_tenant ACTIF existe déjà pour cet email → on ne re-provisionne
 *    pas Twenty (qui refuserait avec un signUpInWorkspace en doublon), on
 *    régénère juste un magic link via le password déchiffré et on retourne
 *    HTTP 200 avec `idempotent: true`.
 *  - Sinon → flow 6 GraphQL calls + INSERT + HTTP 201.
 *
 * Auth : `authenticateAdmin` (cf. lib/admin/authenticate.ts) — x-admin-secret
 * ou session Auth.js avec rôle platform-admin. Rate-limit IP intégré.
 *
 * Sécurité :
 *  - Ne retourne JAMAIS le Bearer Twenty (endpoint dédié /api-key requis)
 *  - Ne retourne JAMAIS le password généré (jamais affiché à qui que ce soit)
 *  - Ne logge pas le Bearer ni le password (audit log = metadata seulement)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { createCrmClientFromEnv } from '@/lib/crm/client';
import { getCrmTenantByEmail } from '@/lib/crm/select-tenant';
import { CrmClientError } from '@/lib/crm/types';
import { decryptSecret, encryptSecret } from '@/lib/crm/vault';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  // Normalisation amont (trim) — Zod `.email()` rejette les espaces de bord.
  email: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string().email().max(320),
  ),
  // workspace_name affiché en clair dans Twenty UI — on bloque les
  // caractères de contrôle pour éviter les surprises (CSV exports, logs,
  // titres HTML). React échappe côté affichage.
  workspace_name: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !/[\x00-\x1f<>]/.test(s), {
      message: 'workspace_name: no control characters or < >',
    }),
});

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const email = parsed.data.email.trim().toLowerCase();
  const workspaceName = parsed.data.workspace_name.trim();

  // 1. Lookup user Hub — pas de création implicite.
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, supabaseUserId: true },
  });
  if (!user || !user.supabaseUserId) {
    return NextResponse.json(
      {
        error: 'user_not_found',
        message:
          "Le user Hub n'existe pas ou n'a pas de supabaseUserId. Appelez d'abord POST /api/admin/users/create.",
      },
      { status: 404 },
    );
  }
  const userUuid = user.supabaseUserId;

  // 2. Idempotence — si un crm_tenant actif existe déjà pour cet email,
  //    on régénère juste un magic link.
  const existing = await getCrmTenantByEmail(email);
  if (existing) {
    const existingRow = await prisma.crmTenant.findUnique({ where: { id: existing.id } });
    if (!existingRow) {
      // Race condition extrêmement rare (suppression entre les 2 lookups).
      // On laisse tomber dans le flow create normal en repassant à l'étape 3.
    } else {
      try {
        const client = createCrmClientFromEnv();
        const password = decryptSecret(existingRow.twentyPasswordEncrypted);
        const { magicLinkUrl, expiresAt } = await client.regenerateMagicLink({
          email: existingRow.email,
          passwordDecrypted: password,
          workspaceUrl: existingRow.twentyWorkspaceUrl,
        });

        const actor = resolveActor(request.headers, authResult.sessionEmail);
        await writeAuditLog(prisma, {
          action: 'admin.crm.tenant.create',
          actor,
          targetType: 'tenant',
          targetId: existingRow.id,
          payload: {
            email,
            idempotent: true,
            twenty_workspace_id: existingRow.twentyWorkspaceId,
          },
        });

        return NextResponse.json(
          {
            tenantId: existingRow.id,
            twentyWorkspaceId: existingRow.twentyWorkspaceId,
            twentyWorkspaceUrl: existingRow.twentyWorkspaceUrl,
            twentyApiKeyId: existingRow.twentyApiKeyId,
            twentyApiKeyExpiresAt: existingRow.twentyApiKeyExpiresAt.toISOString(),
            magicLinkUrl,
            magicLinkExpiresAt: expiresAt.toISOString(),
            createdAt: existingRow.createdAt.toISOString(),
            idempotent: true,
          },
          { status: 200 },
        );
      } catch (err) {
        return errorResponse(err, 'idempotent-regenerate-magic-link');
      }
    }
  }

  // 3. Flow create normal — 6 GraphQL calls.
  let provisionResult;
  try {
    const client = createCrmClientFromEnv();
    provisionResult = await client.createTenant({ email, workspaceName });
  } catch (err) {
    return errorResponse(err, 'create-tenant');
  }

  // 4. Chiffrement + INSERT atomique (1 seul writer côté Hub donc pas
  //    besoin de transaction multi-statement — la table a UNIQUE
  //    twenty_workspace_id qui rattrape un éventuel doublon).
  let apiKeyEncrypted: string;
  let passwordEncrypted: string;
  try {
    apiKeyEncrypted = encryptSecret(provisionResult.twentyApiKeyToken);
    passwordEncrypted = encryptSecret(provisionResult.passwordGenerated);
  } catch (err) {
    // Vault key missing/invalid : on a déjà créé le tenant côté Twenty
    // mais on ne peut pas le persister. C'est un cas exceptionnel
    // (mauvaise config staging/prod) — on log fort pour qu'un humain
    // nettoie le tenant Twenty orphelin côté DB postgres.
    console.error(
      JSON.stringify({
        tag: '[crm-vault-failed]',
        level: 'error',
        twenty_workspace_id: provisionResult.twentyWorkspaceId,
        twenty_api_key_id: provisionResult.twentyApiKeyId,
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      {
        error: 'vault_unavailable',
        message:
          'Twenty tenant créé mais Hub vault indisponible. Tenant Twenty à nettoyer manuellement.',
        twenty_workspace_id: provisionResult.twentyWorkspaceId,
      },
      { status: 500 },
    );
  }

  const created = await prisma.crmTenant.create({
    data: {
      userId: userUuid,
      email,
      workspaceDisplayName: workspaceName,
      twentyWorkspaceId: provisionResult.twentyWorkspaceId,
      twentyWorkspaceUrl: provisionResult.twentyWorkspaceUrl,
      twentyApiKeyId: provisionResult.twentyApiKeyId,
      twentyApiKeyEncrypted: apiKeyEncrypted,
      twentyApiKeyExpiresAt: provisionResult.twentyApiKeyExpiresAt,
      twentyPasswordEncrypted: passwordEncrypted,
      status: 'active',
      provisionedAt: new Date(),
    },
  });

  const actor = resolveActor(request.headers, authResult.sessionEmail);
  await writeAuditLog(prisma, {
    action: 'admin.crm.tenant.create',
    actor,
    targetType: 'tenant',
    targetId: created.id,
    payload: {
      email,
      workspace_name: workspaceName,
      twenty_workspace_id: provisionResult.twentyWorkspaceId,
      twenty_api_key_id: provisionResult.twentyApiKeyId,
      twenty_api_key_expires_at: provisionResult.twentyApiKeyExpiresAt.toISOString(),
      idempotent: false,
    },
  });

  return NextResponse.json(
    {
      tenantId: created.id,
      twentyWorkspaceId: created.twentyWorkspaceId,
      twentyWorkspaceUrl: created.twentyWorkspaceUrl,
      twentyApiKeyId: created.twentyApiKeyId,
      twentyApiKeyExpiresAt: created.twentyApiKeyExpiresAt.toISOString(),
      magicLinkUrl: provisionResult.initialMagicLinkUrl,
      createdAt: created.createdAt.toISOString(),
      idempotent: false,
    },
    { status: 201 },
  );
}

function errorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof CrmClientError) {
    console.error(
      JSON.stringify({
        tag: '[crm-client-error]',
        level: 'error',
        context,
        step: err.step,
        status: err.status,
        message: err.message,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      {
        error: 'crm_upstream_error',
        step: err.step,
        message: err.message,
      },
      { status: 502 },
    );
  }
  console.error(
    JSON.stringify({
      tag: '[crm-unknown-error]',
      level: 'error',
      context,
      message: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    }),
  );
  return NextResponse.json(
    { error: 'internal_error', message: 'Unexpected error provisioning CRM tenant.' },
    { status: 500 },
  );
}

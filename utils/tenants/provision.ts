/**
 * Tenant Provisioning Utilities
 * Crée automatiquement les tenants Twenty + Notifuse au signup
 *
 * Migration Auth.js v5 / Prisma (2026-05-08) :
 * - Plus aucune dépendance à Supabase ici. Toutes les écritures de la table
 *   `tenants` passent par Prisma (`prisma.tenant.*`).
 * - L'API publique `provisionTenants(email, password, userId)` est inchangée.
 *   `userId` reste un UUID stringifié (= ancien `auth.users.id` Supabase pour
 *   les users migrés, sinon UUID neuf généré côté API). Il est inséré tel
 *   quel dans `tenant.user_id` (UUID).
 */

import { logProvisionStart, logProvisionEnd, logStep, logError } from './debug';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
import { prisma } from '@/lib/prisma';

const TWENTY_API_URL = process.env.TWENTY_GRAPHQL_URL!;
const TWENTY_METADATA_URL = process.env.TWENTY_METADATA_URL!;
const TWENTY_FRONTEND_URL = process.env.TWENTY_FRONTEND_URL!;

// ============================================================
// Helpers
// ============================================================

async function graphqlRequest(
  url: string,
  query: string,
  variables: any = {},
  token: string | null = null
) {
  const headers: any = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (data.errors) {
    const operationMatch = query.match(/(?:query|mutation)\s+(\w+)/);
    const operationName = operationMatch ? operationMatch[1] : 'Unknown';
    console.error(`[Twenty] ${operationName} failed:`, data.errors[0]?.message);
    throw new Error(data.errors[0]?.message || 'GraphQL Error');
  }

  return data.data;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(email: string): string {
  return email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// ============================================================
// Twenty CRM Provisioning
// ============================================================

export async function provisionTwentyTenant(
  email: string,
  password: string,
  userId: string
): Promise<{
  success: boolean;
  workspaceId?: string;
  subdomain?: string;
  apiKey?: string;
  loginToken?: string;
  error?: string;
}> {
  const startTime = Date.now();
  try {
    logStep('TWENTY', 'Starting provisioning', { email, userId });

    const workspaceName = email.split('@')[0] + "'s Workspace";

    // Step 1: SignUp
    logStep('TWENTY', '1. Creating user account...');
    try {
      await graphqlRequest(
        TWENTY_API_URL,
        `
          mutation SignUp($email: String!, $password: String!) {
            signUp(email: $email, password: $password) {
              tokens {
                refreshToken { token }
              }
            }
          }
        `,
        { email, password }
      );
      logStep('TWENTY', 'User account created');
    } catch (error: any) {
      if (
        error.message?.includes('USER_ALREADY_EXISTS') ||
        error.message?.includes('already exists')
      ) {
        logStep('TWENTY', 'User already exists, continuing...');
      } else {
        throw error;
      }
    }

    // Step 2: SignIn
    logStep('TWENTY', '2. Signing in...');
    const signInResult = await graphqlRequest(
      TWENTY_API_URL,
      `
        mutation SignIn($email: String!, $password: String!) {
          signIn(email: $email, password: $password) {
            tokens {
              accessOrWorkspaceAgnosticToken { token }
            }
          }
        }
      `,
      { email, password }
    );

    const userToken =
      signInResult.signIn.tokens.accessOrWorkspaceAgnosticToken.token;
    logStep('TWENTY', 'User token obtained');

    // Step 3: Create Workspace
    logStep('TWENTY', '3. Creating workspace...');
    const wsResult = await graphqlRequest(
      TWENTY_API_URL,
      `
        mutation {
          signUpInNewWorkspace {
            loginToken { token }
            workspace {
              id
              workspaceUrls { subdomainUrl }
            }
          }
        }
      `,
      {},
      userToken
    );

    const workspaceId = wsResult.signUpInNewWorkspace.workspace.id;
    const loginToken = wsResult.signUpInNewWorkspace.loginToken.token;
    const workspaceUrl =
      wsResult.signUpInNewWorkspace.workspace.workspaceUrls.subdomainUrl;
    const subdomain = workspaceUrl
      .replace('http://', '')
      .replace('https://', '')
      .split('.')[0];

    logStep('TWENTY', 'Workspace created', { workspaceId, subdomain });

    // Step 4: Get Workspace Token
    const tokensResult = await graphqlRequest(
      TWENTY_API_URL,
      `
        mutation GetTokens($loginToken: String!, $origin: String!) {
          getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
            tokens {
              accessOrWorkspaceAgnosticToken { token }
            }
          }
        }
      `,
      {
        loginToken,
        origin: workspaceUrl || TWENTY_FRONTEND_URL,
      }
    );

    const workspaceToken =
      tokensResult.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;

    // Step 5: Activate Workspace
    await graphqlRequest(
      TWENTY_API_URL,
      `
        mutation ActivateWorkspace($input: ActivateWorkspaceInput!) {
          activateWorkspace(data: $input) {
            id
            displayName
          }
        }
      `,
      { input: { displayName: workspaceName } },
      workspaceToken
    );

    logStep('TWENTY', 'Workspace activated');

    // Step 5b: Create Stripe trial subscription for Twenty billing paywall
    logStep('TWENTY', '5b. Creating Stripe trial subscription...');
    try {
      const { stripe } = await import('@/utils/stripe/config');

      // Create Stripe customer linked to this workspace
      const customer = await stripe.customers.create({
        email,
        metadata: {
          workspaceId,
          userUuid: userId,
          source: 'veridian-auto-provision',
        },
      });

      // Find active Pro monthly prices via lookup_keys (licensed + metered)
      const { data: licensedPrices } = await stripe.prices.list({
        lookup_keys: ['veridian_pro_monthly_v3'],
        limit: 1,
      });
      const { data: meteredPrices } = await stripe.prices.list({
        lookup_keys: ['veridian_pro_workflow_monthly_v1'],
        limit: 1,
      });

      const licensedPrice = licensedPrices[0];
      const meteredPrice = meteredPrices[0];

      if (!licensedPrice) {
        throw new Error('No Pro monthly licensed price found (lookup_key: veridian_pro_monthly_v3)');
      }
      if (!meteredPrice) {
        throw new Error('No Pro monthly metered price found (lookup_key: veridian_pro_workflow_monthly_v1)');
      }

      // Create subscription with N-day trial (no payment required)
      const trialDays = parseInt(process.env.TRIAL_PERIOD_DAYS || process.env.NEXT_PUBLIC_TRIAL_PERIOD_DAYS || '7', 10);
      const trialEnd = Math.floor(Date.now() / 1000) + trialDays * 24 * 60 * 60;

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [
          { price: licensedPrice.id },
          { price: meteredPrice.id },
        ],
        trial_end: trialEnd,
        metadata: { workspaceId, plan: 'PRO', userUuid: userId },
        payment_settings: {
          save_default_payment_method: 'on_subscription',
        },
      });

      logStep('TWENTY', `Trial subscription created: ${subscription.id} (${trialDays} days, 2 items)`);
    } catch (trialError: any) {
      // Non-blocking: workspace is created, user can still subscribe manually
      console.error('[TWENTY] Trial subscription failed (non-blocking):', trialError.message);
      logStep('TWENTY', 'Trial subscription failed, user will need to subscribe via /plan-required');
    }

    // Step 6: Wait for roles
    logStep('TWENTY', '6. Waiting for roles (3s)...');
    await sleep(3000);

    // Step 7: Get Roles
    logStep('TWENTY', '7. Fetching roles...');
    const rolesResult = await graphqlRequest(
      TWENTY_METADATA_URL,
      `
        query {
          getRoles {
            id
            label
          }
        }
      `,
      {},
      workspaceToken
    );

    if (!rolesResult.getRoles || rolesResult.getRoles.length === 0) {
      throw new Error('No roles found in workspace');
    }

    // Find Admin role (preferred) or fallback to first role
    const adminRole = rolesResult.getRoles.find((r: any) => r.label === 'Admin');
    const roleId = adminRole ? adminRole.id : rolesResult.getRoles[0].id;

    if (process.env.NODE_ENV === 'development') {
      console.log('[TWENTY] Selected role:', adminRole ? 'Admin' : rolesResult.getRoles[0].label, '->', roleId);
    }

    // Step 8: Create API Key
    const expiresAt = new Date(
      Date.now() + 365 * 24 * 60 * 60 * 1000
    ).toISOString();

    const apiKeyResult = await graphqlRequest(
      TWENTY_METADATA_URL,
      `
        mutation CreateApiKey($input: CreateApiKeyInput!) {
          createApiKey(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          name: 'Dashboard Auto-generated Key',
          expiresAt,
          roleId,
        },
      },
      workspaceToken
    );

    const apiKeyId = apiKeyResult.createApiKey.id;

    // Step 9: Generate API Key Token
    const tokenResult = await graphqlRequest(
      TWENTY_API_URL,
      `
        mutation GenerateApiKeyToken($apiKeyId: UUID!, $expiresAt: String!) {
          generateApiKeyToken(apiKeyId: $apiKeyId, expiresAt: $expiresAt) {
            token
          }
        }
      `,
      { apiKeyId, expiresAt },
      workspaceToken
    );

    const apiKeyToken = tokenResult.generateApiKeyToken.token;

    logStep('TWENTY', 'API key created and token generated');

    // Step 10: Store via Prisma
    const slug = slugify(email);

    // Calculate trial end date
    const trialDaysTotal = parseInt(process.env.TRIAL_PERIOD_DAYS || '15', 10);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDaysTotal);

    const tenantData = {
      userId,
      name: workspaceName,
      slug,
      status: 'active' as const,
      twentyWorkspaceId: workspaceId,
      twentySubdomain: subdomain,
      twentyApiKey: apiKeyToken,
      twentyUserEmail: email,
      twentyUserPassword: password,
      twentyLoginToken: loginToken,
      twentyLoginTokenCreatedAt: new Date(),
      provisionedAt: new Date(),
      trialEndsAt,
      metadata: {
        workspace_url: workspaceUrl,
        api_key_id: apiKeyId,
        role_id: roleId,
        api_key_expires_at: expiresAt,
        provisioned_by: 'auto-signup',
      },
    };

    const existingTenant = await prisma.tenant.findFirst({
      where: { userId },
      select: { id: true, slug: true },
    });

    let tenantId: string;

    if (existingTenant) {
      // Garde le slug existant pour ne pas violer l'unique constraint
      const { slug: _ignored, ...rest } = tenantData;
      const updated = await prisma.tenant.update({
        where: { id: existingTenant.id },
        data: rest,
        select: { id: true },
      });
      tenantId = updated.id;
    } else {
      // Si le slug est déjà pris (collision rare), on suffixe avec un random
      let finalSlug = slug;
      const slugTaken = await prisma.tenant.findUnique({
        where: { slug: finalSlug },
        select: { id: true },
      });
      if (slugTaken) {
        finalSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
      }
      const created = await prisma.tenant.create({
        data: { ...tenantData, slug: finalSlug },
        select: { id: true },
      });
      tenantId = created.id;
    }

    // Log de provisioning (non bloquant)
    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'success',
          service: 'twenty',
          message: 'Twenty provisioned',
          metadata: { workspaceId, subdomain, apiKeyId },
        },
      });
    } catch (logErr) {
      console.warn('[TWENTY] provisioning_log create failed:', logErr);
    }

    const duration = Date.now() - startTime;
    logStep('TWENTY', 'Stored in DB');
    logStep('TWENTY', `Provisioning completed in ${(duration / 1000).toFixed(2)}s`);

    return {
      success: true,
      workspaceId,
      subdomain,
      apiKey: apiKeyToken,
      loginToken,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logError('TWENTY', error);
    logStep('TWENTY', `Provisioning failed after ${(duration / 1000).toFixed(2)}s`);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================================
// Notifuse Provisioning
// ============================================================

export async function provisionNotifuseTenant(
  email: string,
  userId: string
): Promise<{
  success: boolean;
  workspaceId?: string;
  apiKey?: string;
  magicLink?: string;
  autoLoginUrl?: string;
  error?: string;
}> {
  try {
    const apiUrl = process.env.NOTIFUSE_API_URL;
    const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
    if (!apiUrl || !hubSecret) {
      throw new Error(
        'Notifuse client not configured (NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET)',
      );
    }

    logStep('NOTIFUSE', 'Starting provisioning', { email, userId });

    const workspaceId = email
      .split('@')[0]
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(0, 32);

    const workspaceName = email.split('@')[0].slice(0, 32);

    const client = new NotifuseClient({ apiUrl, hubSecret });
    const result = await client.provisionWorkspace({
      tenantId: workspaceId,
      ownerEmail: email,
      workspaceName,
      plan: 'free',
    });

    logStep('NOTIFUSE', result.created ? 'Workspace created' : 'Workspace already existed');

    const tenantData = {
      notifuseWorkspaceSlug: result.workspace_id,
      notifuseApiKey: result.api_key,
      notifuseUserEmail: email,
      metadata: {
        api_key_email: result.api_key_email,
        workspace_created_at: new Date().toISOString(),
      } as any,
    };

    const existingTenant = await prisma.tenant.findFirst({
      where: { userId },
      select: { id: true, metadata: true },
    });

    let tenantId: string;

    if (existingTenant) {
      const mergedMetadata = {
        ...((existingTenant.metadata as Record<string, unknown>) || {}),
        ...tenantData.metadata,
      };
      const updated = await prisma.tenant.update({
        where: { id: existingTenant.id },
        data: { ...tenantData, metadata: mergedMetadata },
        select: { id: true },
      });
      tenantId = updated.id;
    } else {
      const slug = slugify(email);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 15);

      // Si le slug est déjà pris (collision rare), on suffixe
      let finalSlug = slug;
      const slugTaken = await prisma.tenant.findUnique({
        where: { slug: finalSlug },
        select: { id: true },
      });
      if (slugTaken) {
        finalSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
      }

      const created = await prisma.tenant.create({
        data: {
          userId,
          name: workspaceName,
          slug: finalSlug,
          status: 'active',
          ...tenantData,
          provisionedAt: new Date(),
          trialEndsAt,
        },
        select: { id: true },
      });
      tenantId = created.id;
    }

    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'success',
          service: 'notifuse',
          message: 'Notifuse provisioned',
          metadata: { workspaceId: result.workspace_id, created: result.created },
        },
      });
    } catch (logErr) {
      console.warn('[NOTIFUSE] provisioning_log create failed:', logErr);
    }

    logStep('NOTIFUSE', 'Stored in DB');

    return {
      success: true,
      workspaceId: result.workspace_id,
      apiKey: result.api_key,
      magicLink: result.magic_link,
      // === Veridian patch === Auto-login URL : permet click -> connecté direct
      // sans saisir le code par email. TTL 60s donc valide uniquement après le
      // signup immédiat. Le Hub doit générer un fresh URL via /api/admin/notifuse/magic-link
      // pour les usages ultérieurs.
      autoLoginUrl: result.auto_login_url,
    };
  } catch (error: any) {
    const message =
      error instanceof NotifuseError
        ? `${error.message} (HTTP ${error.code})`
        : error.message;
    console.error('[Notifuse Provision] Error:', message);
    return {
      success: false,
      error: message,
    };
  }
}

// ============================================================
// Prospection Provisioning
// ============================================================

export async function provisionProspectionTenant(
  email: string,
  userId: string
): Promise<{
  success: boolean;
  tenantId?: string;
  loginUrl?: string;
  apiKey?: string;
  error?: string;
}> {
  const PROSPECTION_URL = process.env.PROSPECTION_API_URL;
  const PROSPECTION_SECRET = process.env.PROSPECTION_TENANT_API_SECRET;

  if (!PROSPECTION_URL || !PROSPECTION_SECRET) {
    logStep('PROSPECTION', 'Not configured (missing PROSPECTION_API_URL or PROSPECTION_TENANT_API_SECRET), skipping');
    return { success: false, error: 'Not configured' };
  }

  try {
    logStep('PROSPECTION', 'Starting provisioning', { email, userId });

    // HMAC-signed request (no secret in headers)
    const timestamp = Date.now();
    const { createHmac: hmac } = await import('crypto');
    const signature = hmac('sha256', PROSPECTION_SECRET)
      .update(`${email}:${timestamp}`)
      .digest('hex');

    const res = await fetch(`${PROSPECTION_URL}/api/tenants/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        name: email.split('@')[0],
        plan: 'freemium',
        timestamp,
        signature,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Provision failed: ${res.status} - ${errorText}`);
    }

    const data = await res.json();
    logStep('PROSPECTION', 'Provisioned', {
      tenantId: data.tenant_id,
      created: data.created,
    });

    const prospectionData = {
      prospectionApiKey: data.api_key,
      prospectionLoginToken: data.login_url?.split('t=')[1] ?? null,
      prospectionLoginTokenCreatedAt: new Date(),
      prospectionPlan: 'freemium',
      prospectionProvisionedAt: new Date(),
    };

    const existingTenant = await prisma.tenant.findFirst({
      where: { userId },
      select: { id: true },
    });

    let tenantId: string;

    if (existingTenant) {
      const updated = await prisma.tenant.update({
        where: { id: existingTenant.id },
        data: prospectionData,
        select: { id: true },
      });
      tenantId = updated.id;
    } else {
      const slug = slugify(email);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 15);

      let finalSlug = slug;
      const slugTaken = await prisma.tenant.findUnique({
        where: { slug: finalSlug },
        select: { id: true },
      });
      if (slugTaken) {
        finalSlug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
      }

      const created = await prisma.tenant.create({
        data: {
          userId,
          name: email.split('@')[0],
          slug: finalSlug,
          status: 'active',
          ...prospectionData,
          provisionedAt: new Date(),
          trialEndsAt,
        },
        select: { id: true },
      });
      tenantId = created.id;
    }

    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'success',
          service: 'prospection',
          message: 'Prospection provisioned',
          metadata: { tenantIdRemote: data.tenant_id, created: data.created },
        },
      });
    } catch (logErr) {
      console.warn('[PROSPECTION] provisioning_log create failed:', logErr);
    }

    logStep('PROSPECTION', 'Stored in DB');

    return {
      success: true,
      tenantId: data.tenant_id,
      loginUrl: data.login_url,
      apiKey: data.api_key,
    };
  } catch (error: any) {
    logError('PROSPECTION', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================================
// Provision All (called at signup)
// ============================================================

export async function provisionTenants(
  email: string,
  password: string,
  userId: string
): Promise<{
  success: boolean;
  twenty?: any;
  notifuse?: any;
  prospection?: any;
  errors?: string[];
}> {
  const startTime = Date.now();
  logProvisionStart(email, userId);

  const errors: string[] = [];

  // Resolve Twenty password: use provided password, or read from existing tenant, or generate one
  let twentyPassword = password;
  if (!twentyPassword) {
    try {
      const tenant = await prisma.tenant.findFirst({
        where: { userId },
        select: { twentyUserPassword: true },
      });
      if (tenant?.twentyUserPassword) {
        twentyPassword = tenant.twentyUserPassword;
        logStep('TWENTY', 'Reusing stored password for retry');
      }
    } catch { /* ignore */ }
  }
  if (!twentyPassword) {
    // Generate a random password — user connects via auto-login token, never types this
    twentyPassword = `V${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}!`;
    logStep('TWENTY', 'Generated random password (user uses auto-login)');
  }

  // Provisionner en parallèle
  const [twentyResult, notifuseResult, prospectionResult] = await Promise.allSettled([
    provisionTwentyTenant(email, twentyPassword, userId),
    provisionNotifuseTenant(email, userId),
    provisionProspectionTenant(email, userId),
  ]);

  const twenty =
    twentyResult.status === 'fulfilled' ? twentyResult.value : null;
  const notifuse =
    notifuseResult.status === 'fulfilled' ? notifuseResult.value : null;
  const prospection =
    prospectionResult.status === 'fulfilled' ? prospectionResult.value : null;

  if (twentyResult.status === 'rejected') {
    errors.push(`Twenty: ${twentyResult.reason}`);
  } else if (!twenty?.success) {
    errors.push(`Twenty: ${twenty?.error}`);
  }

  if (notifuseResult.status === 'rejected') {
    errors.push(`Notifuse: ${notifuseResult.reason}`);
  } else if (!notifuse?.success) {
    errors.push(`Notifuse: ${notifuse?.error}`);
  }

  if (prospectionResult.status === 'rejected') {
    errors.push(`Prospection: ${prospectionResult.reason}`);
  } else if (!prospection?.success) {
    // Prospection not configured is OK (not an error worth reporting)
    if (prospection?.error !== 'Not configured') {
      errors.push(`Prospection: ${prospection?.error}`);
    }
  }

  const success = !!(twenty?.success || notifuse?.success || prospection?.success);
  const duration = Date.now() - startTime;

  logProvisionEnd(success, duration, errors.length > 0 ? errors : undefined);

  // Summary toujours loggé (même en prod) pour monitoring
  console.log('[Provision Tenants] Summary:', {
    success,
    twentySuccess: twenty?.success,
    notifuseSuccess: notifuse?.success,
    prospectionSuccess: prospection?.success,
    duration_ms: duration,
    errors: errors.length,
  });

  return {
    success,
    twenty,
    notifuse,
    prospection,
    errors: errors.length > 0 ? errors : undefined,
  };
}

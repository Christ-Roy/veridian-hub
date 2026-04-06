/**
 * Tenant Provisioning Utilities
 * Crée automatiquement les tenants Twenty + Notifuse au signup
 */

import { createHmac } from 'crypto';
import { logProvisionStart, logProvisionEnd, logStep, logError } from './debug';

// Import correct Supabase admin client (handles URLs and auth properly)
// Using getSupabaseAdmin() from utils/supabase/admin.ts instead of direct createClient
// This ensures proper configuration for Docker internal URLs

const TWENTY_API_URL = process.env.TWENTY_GRAPHQL_URL!;
const TWENTY_METADATA_URL = process.env.TWENTY_METADATA_URL!;
const TWENTY_FRONTEND_URL = process.env.TWENTY_FRONTEND_URL!;
const NOTIFUSE_API_URL = process.env.NOTIFUSE_API_URL!;
const NOTIFUSE_ROOT_EMAIL = process.env.NOTIFUSE_ROOT_EMAIL!;
const NOTIFUSE_SECRET_KEY = process.env.NOTIFUSE_SECRET_KEY!;

// ============================================================
// Helpers
// ============================================================

/**
 * Génère une signature HMAC-SHA256 pour l'authentification Notifuse rootSignin
 */
function generateHmacSignature(email: string, timestamp: number, secretKey: string): string {
  const message = `${email}:${timestamp}`;
  return createHmac('sha256', secretKey).update(message).digest('hex');
}

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

async function notifuseRequest(
  endpoint: string,
  method: string = 'GET',
  body: any = null,
  token: string | null = null
) {
  const headers: any = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options: RequestInit = {
    method,
    headers,
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const fullUrl = `${NOTIFUSE_API_URL}${endpoint}`;

  const response = await fetch(fullUrl, options);
  const data = await response.json();

  if (data.error) {
    console.error(`[Notifuse] ${method} ${endpoint} failed:`, data.error);
    throw new Error(data.error);
  }

  return data;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    logStep('TWENTY', '🚀 Starting provisioning', { email, userId });

    const workspaceName = email.split('@')[0] + "'s Workspace";

    // Step 1: SignUp
    logStep('TWENTY', '1️⃣ Creating user account...');
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
      logStep('TWENTY', '✅ User account created');
    } catch (error: any) {
      if (
        error.message?.includes('USER_ALREADY_EXISTS') ||
        error.message?.includes('already exists')
      ) {
        logStep('TWENTY', '⚠️  User already exists, continuing...');
      } else {
        throw error;
      }
    }

    // Step 2: SignIn
    logStep('TWENTY', '2️⃣ Signing in...');
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
    logStep('TWENTY', '✅ User token obtained');

    // Step 3: Create Workspace
    logStep('TWENTY', '3️⃣ Creating workspace...');
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

    logStep('TWENTY', '✅ Workspace created', { workspaceId, subdomain });

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

    logStep('TWENTY', '✅ Workspace activated');

    // Step 5b: Create Stripe trial subscription for Twenty billing paywall
    logStep('TWENTY', '5b️⃣ Creating Stripe trial subscription...');
    try {
      const { stripe } = await import('@/utils/stripe/config');

      // Create Stripe customer linked to this workspace
      const customer = await stripe.customers.create({
        email,
        metadata: {
          workspaceId,
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

      // Create subscription with 7-day trial (no payment required)
      // Twenty v1.16.7 requires exactly 2 items: BASE_PRODUCT (licensed) + WORKFLOW_NODE_EXECUTION (metered)
      const trialDays = parseInt(process.env.TRIAL_PERIOD_DAYS || process.env.NEXT_PUBLIC_TRIAL_PERIOD_DAYS || '7', 10);
      const trialEnd = Math.floor(Date.now() / 1000) + trialDays * 24 * 60 * 60;

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [
          { price: licensedPrice.id },
          { price: meteredPrice.id },
        ],
        trial_end: trialEnd,
        metadata: { workspaceId, plan: 'PRO' },
        payment_settings: {
          save_default_payment_method: 'on_subscription',
        },
      });

      logStep('TWENTY', `✅ Trial subscription created: ${subscription.id} (${trialDays} days, 2 items)`);
    } catch (trialError: any) {
      // Non-blocking: workspace is created, user can still subscribe manually
      console.error('[TWENTY] ⚠️ Trial subscription failed (non-blocking):', trialError.message);
      logStep('TWENTY', '⚠️ Trial subscription failed, user will need to subscribe via /plan-required');
    }

    // Step 6: Wait for roles
    logStep('TWENTY', '6️⃣ Waiting for roles (3s)...');
    await sleep(3000);

    // Step 7: Get Roles
    logStep('TWENTY', '7️⃣ Fetching roles...');
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
      console.log('[TWENTY] Selected role:', adminRole ? 'Admin' : rolesResult.getRoles[0].label, '→', roleId);
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

    logStep('TWENTY', '✅ API key created and token generated');

    // Step 10: Store in Supabase
    // Use correct admin client that handles Docker internal URLs
    const { getSupabaseAdmin } = await import('@/utils/supabase/admin');
    const supabase = getSupabaseAdmin();

    const slug = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();

    // Check if tenant exists
    const { data: existingTenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    // Calculate trial end date
    const trialDaysTotal = parseInt(process.env.TRIAL_PERIOD_DAYS || '15', 10);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDaysTotal);

    const tenantData = {
      user_id: userId,
      name: workspaceName,
      slug: slug,
      status: 'active' as const,
      twenty_workspace_id: workspaceId,
      twenty_subdomain: subdomain,
      twenty_api_key: apiKeyToken,
      twenty_user_email: email,
      twenty_user_password: password,
      twenty_login_token: loginToken,
      twenty_login_token_created_at: new Date().toISOString(),
      provisioned_at: new Date().toISOString(),
      trial_ends_at: trialEndsAt.toISOString(),
      metadata: {
        workspace_url: workspaceUrl,
        api_key_id: apiKeyId,
        role_id: roleId,
        api_key_expires_at: expiresAt,
        provisioned_by: 'auto-signup',
      },
    };

    if (existingTenant) {
      const { error: updateError } = await supabase
        .from('tenants')
        .update(tenantData)
        .eq('id', existingTenant.id);

      if (updateError) {
        console.error('[TWENTY] Error updating tenant:', updateError);
        throw new Error(`Failed to update tenant: ${updateError.message}`);
      }
    } else {
      const { error: insertError } = await supabase.from('tenants').insert(tenantData);

      if (insertError) {
        console.error('[TWENTY] Error inserting tenant:', insertError);
        throw new Error(`Failed to insert tenant: ${insertError.message}`);
      }
    }

    const duration = Date.now() - startTime;
    logStep('TWENTY', '✅ Stored in Supabase');
    logStep('TWENTY', `🎉 Provisioning completed in ${(duration / 1000).toFixed(2)}s`);

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
    logStep('TWENTY', `❌ Provisioning failed after ${(duration / 1000).toFixed(2)}s`);
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
  error?: string;
}> {
  try {
    console.log('[Notifuse Provision] Starting for:', email);

    const workspaceId = email
      .split('@')[0]
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .slice(0, 32);

    const workspaceName = email.split('@')[0].slice(0, 32);

    // Step 1: Authenticate as root using rootSignin API (no email needed)
    logStep('NOTIFUSE', '1️⃣ Authenticating as root...');
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateHmacSignature(
      NOTIFUSE_ROOT_EMAIL,
      timestamp,
      NOTIFUSE_SECRET_KEY
    );

    const signinData = await notifuseRequest(
      '/api/user.rootSignin',
      'POST',
      {
        email: NOTIFUSE_ROOT_EMAIL,
        timestamp: timestamp,
        signature: signature,
      }
    );

    if (!signinData.token) {
      throw new Error('No JWT token received from rootSignin');
    }

    const adminToken = signinData.token;
    logStep('NOTIFUSE', '✅ Root authentication successful');

    // Step 3: Create workspace
    try {
      await notifuseRequest(
        '/api/workspaces.create',
        'POST',
        {
          id: workspaceId,
          name: workspaceName,
          settings: { timezone: 'UTC' },
        },
        adminToken
      );
      console.log('[Notifuse Provision] Workspace created');
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log('[Notifuse Provision] Workspace already exists, continuing...');
      } else {
        throw error;
      }
    }

    // Step 4: Generate API key
    const emailPrefix = `api${Date.now()}`;
    const apiKeyData = await notifuseRequest(
      '/api/workspaces.createAPIKey',
      'POST',
      {
        workspace_id: workspaceId,
        email_prefix: emailPrefix,
      },
      adminToken
    );

    if (!apiKeyData.token) {
      throw new Error('No API key received');
    }

    const apiKeyToken = apiKeyData.token;
    logStep('NOTIFUSE', '✅ API key created');
    logStep('NOTIFUSE', '📧 Workspace ready - User needs to accept invitation via email');

    // Step 5: Complete the setup wizard using Playwright (if available)
    const notifuseConsoleUrl = process.env.NEXT_PUBLIC_NOTIFUSE_URL || 'https://notifuse.dev.veridian.site';
    const setupWizardUrl = `${notifuseConsoleUrl}/console/setup`;

    try {
      logStep('NOTIFUSE', '🤖 Attempting to complete setup wizard automatically...');

      // Try to use Playwright if available
      const { exec } = await import('child_process');

      const playwrightCommand = `node scripts/playwright/complete-notifuse-wizard.mjs "${setupWizardUrl}"`;

      // Run in background, don't block
      exec(playwrightCommand, {
        cwd: process.cwd(),
        timeout: 30000,
        env: {
          ...process.env,
          NODE_ENV: 'development',
        },
      }, (error) => {
        if (error) {
          console.log('[NOTIFUSE] ⚠️  Auto-completion failed (non-blocking):', error.message);
          console.log('[NOTIFUSE] 💡 Manual action required: Visit', setupWizardUrl);
        } else {
          console.log('[NOTIFUSE] ✅ Setup wizard completed automatically!');
        }
      });

      logStep('NOTIFUSE', '🔄 Wizard automation running in background...');
    } catch (error) {
      // Playwright not available or failed - not blocking
      logStep('NOTIFUSE', '⚠️  Wizard automation skipped (Playwright not available)');
      logStep('NOTIFUSE', '💡 Manual action required: Visit ' + setupWizardUrl);
    }

    // Step 6: Store in Supabase
    // Use correct admin client that handles Docker internal URLs
    const { getSupabaseAdmin } = await import('@/utils/supabase/admin');
    const supabase = getSupabaseAdmin();

    const { data: existingTenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    const tenantData = {
      notifuse_workspace_slug: workspaceId,
      notifuse_api_key: apiKeyToken,
      notifuse_user_email: email,
      metadata: {
        api_key_email_prefix: emailPrefix,
        workspace_created_at: new Date().toISOString(),
      },
    };

    if (existingTenant) {
      const { error: updateError } = await supabase
        .from('tenants')
        .update(tenantData)
        .eq('id', existingTenant.id);

      if (updateError) {
        console.error('[Notifuse] Error updating tenant:', updateError);
        throw new Error(`Failed to update tenant: ${updateError.message}`);
      }
    } else {
      // Si pas de tenant Twenty créé avant, créer une nouvelle ligne
      const slug = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();

      // Calculate trial end date (15 days from now)
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 15);

      const { error: insertError } = await supabase.from('tenants').insert({
        user_id: userId,
        name: workspaceName,
        slug: slug,
        status: 'active' as const,
        ...tenantData,
        provisioned_at: new Date().toISOString(),
        trial_ends_at: trialEndsAt.toISOString(),
      });

      if (insertError) {
        console.error('[Notifuse] Error inserting tenant:', insertError);
        throw new Error(`Failed to insert tenant: ${insertError.message}`);
      }
    }

    console.log('[Notifuse Provision] Stored in Supabase');

    return {
      success: true,
      workspaceId,
      apiKey: apiKeyToken,
    };
  } catch (error: any) {
    console.error('[Notifuse Provision] Error:', error);
    return {
      success: false,
      error: error.message,
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
    logStep('PROSPECTION', '⚠️ Not configured (missing PROSPECTION_API_URL or PROSPECTION_TENANT_API_SECRET), skipping');
    return { success: false, error: 'Not configured' };
  }

  try {
    logStep('PROSPECTION', '🚀 Starting provisioning', { email, userId });

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
      throw new Error(`Provision failed: ${res.status} — ${errorText}`);
    }

    const data = await res.json();
    logStep('PROSPECTION', '✅ Provisioned', {
      tenantId: data.tenant_id,
      created: data.created,
    });

    // Store in Supabase tenant record
    const { getSupabaseAdmin } = await import('@/utils/supabase/admin');
    const supabase = getSupabaseAdmin();

    // Type cast: Supabase strict mode infers `never` for tenants (enum + new columns)
    const db = supabase.from('tenants') as any;

    const { data: existingTenant } = await db
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    const prospectionData = {
      prospection_api_key: data.api_key,
      prospection_login_token: data.login_url?.split('t=')[1] ?? null,
      prospection_login_token_created_at: new Date().toISOString(),
      prospection_plan: 'freemium',
      prospection_provisioned_at: new Date().toISOString(),
    };

    if (existingTenant) {
      await db.update(prospectionData).eq('id', existingTenant.id);
    } else {
      const slug = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 15);

      await db.insert({
        user_id: userId,
        name: email.split('@')[0],
        slug,
        status: 'active',
        ...prospectionData,
        provisioned_at: new Date().toISOString(),
        trial_ends_at: trialEndsAt.toISOString(),
      });
    }

    logStep('PROSPECTION', '✅ Stored in Supabase');

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
      const { getSupabaseAdmin } = await import('@/utils/supabase/admin');
      const supabase = getSupabaseAdmin();
      const { data: tenant } = await (supabase.from('tenants') as any)
        .select('twenty_user_password')
        .eq('user_id', userId)
        .maybeSingle();
      if (tenant?.twenty_user_password) {
        twentyPassword = tenant.twenty_user_password;
        logStep('TWENTY', '🔑 Reusing stored password for retry');
      }
    } catch { /* ignore */ }
  }
  if (!twentyPassword) {
    // Generate a random password — user connects via auto-login token, never types this
    twentyPassword = `V${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}!`;
    logStep('TWENTY', '🔑 Generated random password (user uses auto-login)');
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

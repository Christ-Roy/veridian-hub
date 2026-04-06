import { NextRequest, NextResponse } from 'next/server';
// Force dynamic rendering - prevent static generation at build time
export const dynamic = 'force-dynamic';
import { createClient } from '@/utils/supabase/server';

// Load Notifuse config from environment variables
// Use empty defaults to allow build-time compilation, real values injected at runtime
const NOTIFUSE_API_BASE = process.env.NEXT_PUBLIC_NOTIFUSE_URL || '';
const ROOT_EMAIL = process.env.NOTIFUSE_ROOT_EMAIL || '';

interface LogEntry {
  timestamp: string;
  step: string;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: any;
}

async function apiRequest(endpoint: string, method: string = 'GET', body?: any, token?: string) {
  const headers: Record<string, string> = {
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

  const response = await fetch(`${NOTIFUSE_API_BASE}${endpoint}`, options);
  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
  }

  return data;
}

export async function POST(request: NextRequest) {
  const logs: LogEntry[] = [];

  // Runtime validation of required environment variables
  if (!NOTIFUSE_API_BASE) {
    return NextResponse.json(
      { error: 'Missing environment variable: NEXT_PUBLIC_NOTIFUSE_URL' },
      { status: 500 }
    );
  }
  if (!ROOT_EMAIL) {
    return NextResponse.json(
      { error: 'Missing environment variable: NOTIFUSE_ROOT_EMAIL' },
      { status: 500 }
    );
  }

  function addLog(type: LogEntry['type'], step: string, message: string, data?: any) {
    const log = {
      timestamp: new Date().toISOString(),
      step,
      type,
      message,
      data,
    };
    logs.push(log);

    // Log en dev mode
    if (process.env.NODE_ENV === 'development') {
      console.log(`[API Notifuse] [${type.toUpperCase()}] ${step}: ${message}`, data || '');
    }
  }

  try {
    // 🔒 SÉCURITÉ : Vérifier que l'utilisateur est authentifié
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      addLog('error', 'auth', 'Unauthorized: User not authenticated');
      return NextResponse.json(
        { success: false, error: 'Unauthorized', logs },
        { status: 401 }
      );
    }

    addLog('info', 'auth', `User authenticated: ${user.email}`);

    const { workspaceId, workspaceName } = await request.json();

    if (!workspaceId || !workspaceName) {
      return NextResponse.json(
        { success: false, error: 'Missing workspaceId or workspaceName', logs },
        { status: 400 }
      );
    }

    // Validate workspace ID format (alphanumeric only)
    if (!/^[a-zA-Z0-9]+$/.test(workspaceId)) {
      return NextResponse.json(
        { success: false, error: 'Workspace ID must be alphanumeric only (no underscores or hyphens)', logs },
        { status: 400 }
      );
    }

    if (workspaceId.length > 32) {
      return NextResponse.json(
        { success: false, error: 'Workspace ID must be 32 characters or less', logs },
        { status: 400 }
      );
    }

    addLog('info', 'start', `Starting tenant provisioning for: ${workspaceId}`);

    // Step 1: Check setup status
    addLog('info', 'setup-check', 'Checking system setup status...');
    const setupStatus = await apiRequest('/api/setup.status');
    addLog('success', 'setup-check', `System initialized: ${setupStatus.is_installed}`);

    // Step 2: Sign in as root user
    addLog('info', 'root-signin', `Signing in as root user: ${ROOT_EMAIL}`);

    const signinData = await apiRequest('/api/user.signin', 'POST', { email: ROOT_EMAIL });

    if (!signinData.code) {
      throw new Error('No magic code received for root user');
    }

    addLog('success', 'root-signin', `Magic code received: ${signinData.code}`);

    // Step 3: Verify magic code to get JWT
    addLog('info', 'verify-code', 'Verifying magic code...');

    const verifyData = await apiRequest('/api/user.verify', 'POST', {
      email: ROOT_EMAIL,
      code: signinData.code,
    });

    if (!verifyData.token) {
      throw new Error('No JWT token received');
    }

    const adminToken = verifyData.token;
    addLog('success', 'verify-code', 'Admin JWT token obtained');

    // Step 4: Create workspace
    addLog('info', 'create-workspace', `Creating workspace: ${workspaceId}`);

    let workspaceCreated = false;
    try {
      await apiRequest(
        '/api/workspaces.create',
        'POST',
        {
          id: workspaceId,
          name: workspaceName,
          settings: { timezone: 'UTC' },
        },
        adminToken
      );
      workspaceCreated = true;
      addLog('success', 'create-workspace', 'Workspace created successfully');
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        addLog('warning', 'create-workspace', 'Workspace already exists, continuing...');
        workspaceCreated = true;
      } else {
        throw error;
      }
    }

    // Step 5: Generate API key
    addLog('info', 'create-api-key', 'Generating API key...');

    const emailPrefix = `api${Date.now()}`;
    const apiKeyData = await apiRequest(
      '/api/workspaces.createAPIKey',
      'POST',
      {
        workspace_id: workspaceId,
        email_prefix: emailPrefix,
      },
      adminToken
    );

    if (!apiKeyData.token) {
      throw new Error('No API key token received');
    }

    addLog('success', 'create-api-key', `API key generated: ${apiKeyData.email}`);

    // Step 6: Invite tenant admin
    const tenantAdminEmail = `admin-${workspaceId}@notifuse.local`;
    addLog('info', 'invite-admin', `Inviting tenant admin: ${tenantAdminEmail}`);

    const inviteData = await apiRequest(
      '/api/workspaces.inviteMember',
      'POST',
      {
        workspace_id: workspaceId,
        email: tenantAdminEmail,
        permissions: {
          workspace: { read: true, write: true },
          contacts: { read: true, write: true },
          lists: { read: true, write: true },
          templates: { read: true, write: true },
          broadcasts: { read: true, write: true },
          transactional_notifications: { read: true, write: true },
          message_history: { read: true, write: true },
          api_keys: { read: true, write: true },
          billing: { read: true, write: true },
          settings: { read: true, write: true },
          webhooks: { read: true, write: true },
        },
      },
      adminToken
    );

    if (!inviteData.token) {
      throw new Error('No invitation token received');
    }

    addLog('success', 'invite-admin', 'Tenant admin invited');

    // Step 7: Accept invitation automatically
    addLog('info', 'accept-invitation', 'Auto-accepting invitation...');

    const acceptData = await apiRequest('/api/workspaces.acceptInvitation', 'POST', {
      token: inviteData.token,
    });

    if (!acceptData.user) {
      throw new Error('User not created');
    }

    addLog('success', 'accept-invitation', `User created: ${acceptData.user.id}`);

    // Step 8: Generate magic link for tenant admin
    addLog('info', 'generate-magic-link', 'Generating magic link for tenant admin...');

    const tenantSigninData = await apiRequest('/api/user.signin', 'POST', { email: tenantAdminEmail });

    if (!tenantSigninData.code) {
      throw new Error('No magic code received for tenant admin');
    }

    const magicLink = `${NOTIFUSE_API_BASE}/console/signin?email=${encodeURIComponent(
      tenantAdminEmail
    )}&code=${tenantSigninData.code}`;

    addLog('success', 'generate-magic-link', 'Magic link generated');
    addLog('success', 'complete', 'Tenant provisioning completed!');

    // Save to Supabase (réutilise supabase et user déjà déclarés)
    if (user) {
      const { error: dbError } = await supabase.from('tenants').upsert({
        user_id: user.id,
        name: workspaceName,
        slug: workspaceId,
        status: 'active',
        notifuse_workspace_slug: workspaceId,
        notifuse_user_email: tenantAdminEmail,
        notifuse_api_key: apiKeyData.token,
      } as any);

      if (dbError) {
        addLog('error', 'database', `Failed to save to database: ${dbError.message}`);
      } else {
        addLog('success', 'database', 'Tenant saved to database');
      }
    }

    return NextResponse.json({
      success: true,
      result: {
        workspaceId,
        workspaceName,
        apiKey: apiKeyData.token,
        apiEmail: apiKeyData.email,
        adminEmail: tenantAdminEmail,
        adminUserId: acceptData.user.id,
        magicCode: tenantSigninData.code,
        magicLink,
      },
      logs,
    });
  } catch (error: any) {
    addLog('error', 'failed', `Error: ${error.message}`, { error: error.message });

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Unknown error',
        logs,
      },
      { status: 500 }
    );
  }
}

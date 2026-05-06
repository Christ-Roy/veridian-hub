import { NextRequest, NextResponse } from 'next/server';

import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

interface LogEntry {
  timestamp: string;
  step: string;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: unknown;
}

export async function POST(request: NextRequest) {
  const logs: LogEntry[] = [];

  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl) {
    return NextResponse.json(
      { error: 'Missing environment variable: NOTIFUSE_API_URL' },
      { status: 500 },
    );
  }
  if (!hubSecret) {
    return NextResponse.json(
      { error: 'Missing environment variable: NOTIFUSE_HUB_API_SECRET' },
      { status: 500 },
    );
  }

  function addLog(type: LogEntry['type'], step: string, message: string, data?: unknown) {
    logs.push({ timestamp: new Date().toISOString(), step, type, message, data });
    if (process.env.NODE_ENV === 'development') {
      console.log(`[API Notifuse] [${type.toUpperCase()}] ${step}: ${message}`, data ?? '');
    }
  }

  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      addLog('error', 'auth', 'Unauthorized: User not authenticated');
      return NextResponse.json(
        { success: false, error: 'Unauthorized', logs },
        { status: 401 },
      );
    }
    addLog('info', 'auth', `User authenticated: ${user.email}`);

    const { workspaceId, workspaceName } = await request.json();

    if (!workspaceId || !workspaceName) {
      return NextResponse.json(
        { success: false, error: 'Missing workspaceId or workspaceName', logs },
        { status: 400 },
      );
    }
    if (!/^[a-zA-Z0-9]+$/.test(workspaceId)) {
      return NextResponse.json(
        { success: false, error: 'Workspace ID must be alphanumeric only (no underscores or hyphens)', logs },
        { status: 400 },
      );
    }
    if (workspaceId.length > 32) {
      return NextResponse.json(
        { success: false, error: 'Workspace ID must be 32 characters or less', logs },
        { status: 400 },
      );
    }

    addLog('info', 'start', `Provisioning Notifuse workspace ${workspaceId}`);

    const client = new NotifuseClient({ apiUrl, hubSecret });
    const result = await client.provisionWorkspace({
      tenantId: workspaceId,
      ownerEmail: user.email!,
      workspaceName,
      plan: 'free',
    });

    addLog('success', 'provision', 'Workspace provisioned via Notifuse Veridian API', {
      created: result.created,
      apiKeyEmail: result.api_key_email,
    });

    const { error: dbError } = await supabase.from('tenants').upsert({
      user_id: user.id,
      name: workspaceName,
      slug: workspaceId,
      status: 'active',
      notifuse_workspace_slug: result.workspace_id,
      notifuse_user_email: user.email!,
      notifuse_api_key: result.api_key,
    } as any);

    if (dbError) {
      addLog('error', 'database', `Failed to save to database: ${dbError.message}`);
    } else {
      addLog('success', 'database', 'Tenant saved to database');
    }

    return NextResponse.json({
      success: true,
      result: {
        workspaceId: result.workspace_id,
        workspaceName,
        apiKey: result.api_key,
        apiEmail: result.api_key_email,
        adminEmail: user.email,
        adminUserId: result.owner_user_id,
        magicLink: result.magic_link,
        plan: result.plan,
        created: result.created,
      },
      logs,
    });
  } catch (error: unknown) {
    if (error instanceof NotifuseError) {
      addLog('error', 'failed', error.message, { code: error.code });
      return NextResponse.json(
        { success: false, error: error.message, code: error.code, logs },
        { status: error.code >= 400 && error.code < 600 ? error.code : 502 },
      );
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    addLog('error', 'failed', message);
    return NextResponse.json(
      { success: false, error: message, logs },
      { status: 500 },
    );
  }
}

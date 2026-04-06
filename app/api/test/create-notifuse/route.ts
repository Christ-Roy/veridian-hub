/**
 * TEST ROUTE - Notifuse Tenant Creation (Updated Flow)
 *
 * Usage:
 *   curl http://localhost:3000/api/test/create-notifuse
 *   curl http://localhost:3000/api/test/create-notifuse?email=test@example.com
 *
 * Teste le workflow complet :
 * 1. Workspace + API key
 * 2. Invitation membre (email envoyé automatiquement en prod)
 */

import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';

// Force dynamic rendering - prevent static generation at build time
export const dynamic = 'force-dynamic';

const NOTIFUSE_API_BASE = process.env.NOTIFUSE_API_URL || 'https://notifuse.app.veridian.site';
const ROOT_EMAIL = process.env.NOTIFUSE_ROOT_EMAIL || 'brunon5robert@gmail.com';
const SECRET_KEY = process.env.NOTIFUSE_SECRET_KEY!;

function generateHmacSignature(email: string, timestamp: number): string {
  const message = `${email}:${timestamp}`;
  return createHmac('sha256', SECRET_KEY).update(message).digest('hex');
}

interface LogEntry {
  timestamp: string;
  step: string;
  type: 'info' | 'success' | 'error';
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

export async function GET(request: Request) {
  const logs: LogEntry[] = [];

  function addLog(type: LogEntry['type'], step: string, message: string, data?: any) {
    const log = {
      timestamp: new Date().toISOString(),
      step,
      type,
      message,
      data,
    };
    logs.push(log);
    console.log(`[${type.toUpperCase()}] ${step}: ${message}`, data || '');
  }

  try {
    // Parse query params
    const { searchParams } = new URL(request.url);
    const userEmail = searchParams.get('email') || `test${Date.now()}@example.com`;
    const workspaceId = userEmail.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    const workspaceName = userEmail.split('@')[0].slice(0, 30);

    addLog('info', 'start', `Creating tenant for: ${userEmail}`);
    addLog('info', 'start', `Workspace ID: ${workspaceId}`);

    // Step 1: Root auth avec HMAC
    addLog('info', 'root-auth', `Authenticating as root: ${ROOT_EMAIL}`);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateHmacSignature(ROOT_EMAIL, timestamp);

    const authResponse = await fetch(`${NOTIFUSE_API_BASE}/api/user.rootSignin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ROOT_EMAIL,
        timestamp,
        signature,
      }),
    });

    const authData = await authResponse.json();
    if (!authData.token) {
      throw new Error('No JWT token received from rootSignin');
    }

    const adminToken = authData.token;
    addLog('success', 'root-auth', 'Root authenticated');

    // Step 2: Create workspace
    addLog('info', 'create-workspace', `Creating workspace: ${workspaceId}`);
    try {
      await apiRequest(
        '/api/workspaces.create',
        'POST',
        {
          id: workspaceId,
          name: workspaceName,
          settings: { timezone: 'Europe/Paris' },
        },
        adminToken
      );
      addLog('success', 'create-workspace', 'Workspace created');
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        addLog('info', 'create-workspace', 'Workspace already exists, continuing');
      } else {
        throw error;
      }
    }

    // Step 3: Create API Key
    addLog('info', 'create-api-key', 'Creating API key...');
    const emailPrefix = 'dashboard';
    try {
      const apiKeyData = await apiRequest(
        '/api/workspaces.createAPIKey',
        'POST',
        {
          workspace_id: workspaceId,
          email_prefix: emailPrefix,
        },
        adminToken
      );

      addLog('success', 'create-api-key', `API key created: ${apiKeyData.email}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        addLog('info', 'create-api-key', 'API key already exists, continuing');
      } else {
        throw error;
      }
    }

    // Step 4: Invite member (avec TOUS les droits comme le script)
    addLog('info', 'invite-member', `Inviting user: ${userEmail}`);
    const inviteData = await apiRequest(
      '/api/workspaces.inviteMember',
      'POST',
      {
        workspace_id: workspaceId,
        email: userEmail,
        permissions: {
          contacts: { read: true, write: true },
          lists: { read: true, write: true },
          templates: { read: true, write: true },
          broadcasts: { read: true, write: true },
          transactional: { read: true, write: true },
          workspace: { read: true, write: true },
          message_history: { read: true, write: true },
          blog: { read: true, write: true },
          automations: { read: true, write: true },
          llm: { read: true, write: true },
        },
      },
      adminToken
    );

    addLog('success', 'invite-member', 'Invitation sent');

    // En dev, le token est retourné
    // En prod, il est vide et l'email est envoyé automatiquement
    const inviteToken = inviteData.token || '';
    const magicLink = inviteToken
      ? `${NOTIFUSE_API_BASE}/console/accept-invitation?token=${inviteToken}`
      : null;

    if (magicLink) {
      addLog('success', 'magic-link', `Magic link available (DEV mode)`);
    } else {
      addLog('info', 'email-sent', `Invitation email sent to ${userEmail} (PROD mode)`);
    }

    addLog('success', 'complete', '✅ Provisioning COMPLETE!');

    return NextResponse.json({
      success: true,
      mode: inviteToken ? 'development' : 'production',
      workspace: {
        id: workspaceId,
        name: workspaceName,
      },
      user: {
        email: userEmail,
      },
      invitation: {
        sent: true,
        magicLink: magicLink || 'Sent by email (check inbox)',
        expiresAt: inviteData.invitation?.expires_at,
      },
      instructions: magicLink
        ? 'Open the magic link to accept the invitation'
        : `Check email ${userEmail} for the invitation link`,
      logs,
    });
  } catch (error: any) {
    addLog('error', 'failed', `❌ ERROR: ${error.message}`, { error: error.message });

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        logs,
      },
      { status: 500 }
    );
  }
}

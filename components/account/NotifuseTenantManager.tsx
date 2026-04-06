'use client';

import { useState } from 'react';
import styles from '@/app/(marketing)/account/account.module.css';

/**
 * NOTIFUSE TENANT MANAGER
 *
 * Composant pour gérer la création de tenants Notifuse.
 * Réutilise la logique du POC notifuse/components/CreateTenantForm.tsx
 * 🔒 Conserve toute la logique backend
 */

interface Log {
  timestamp: Date;
  level: 'info' | 'success' | 'error' | 'request' | 'response';
  message: string;
}

interface TenantResult {
  workspaceId: string;
  workspaceName: string;
  apiKey: string;
  apiEmail: string;
  adminEmail: string;
  adminUserId: string;
  magicCode: string;
  magicLink: string;
}

export default function NotifuseTenantManager() {
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TenantResult | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const addLog = (level: Log['level'], message: string) => {
    setLogs(prev => [...prev, { timestamp: new Date(), level, message }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setResult(null);
    setLogs([]);
    setShowLogs(true);

    const API_BASE = process.env.NEXT_PUBLIC_NOTIFUSE_API_URL;
    const NOTIFUSE_BASE_URL = process.env.NEXT_PUBLIC_NOTIFUSE_URL;
    const ROOT_EMAIL = 'admin@notifuse.local';

    if (!API_BASE || !NOTIFUSE_BASE_URL) {
      addLog('error', '❌ Missing environment variables: NEXT_PUBLIC_NOTIFUSE_API_URL or NEXT_PUBLIC_NOTIFUSE_URL');
      setIsLoading(false);
      return;
    }

    try {
      addLog('info', `🚀 Starting tenant creation for workspace: ${workspaceId}`);

      // Step 1: Request magic code
      addLog('request', `POST ${API_BASE}/user.signin`);
      const signinRes = await fetch(`${API_BASE}/user.signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ROOT_EMAIL })
      });

      const signinData = await signinRes.json();
      if (!signinData.code) throw new Error('No magic code received');
      addLog('success', `✅ Magic code received`);

      // Step 2: Verify and get JWT
      addLog('request', `POST ${API_BASE}/user.verify`);
      const verifyRes = await fetch(`${API_BASE}/user.verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ROOT_EMAIL, code: signinData.code })
      });

      const verifyData = await verifyRes.json();
      if (!verifyData.token) throw new Error('No JWT token received');
      addLog('success', '✅ Admin JWT obtained');

      const ADMIN_TOKEN = verifyData.token;

      // Step 3: Create workspace
      addLog('request', `POST ${API_BASE}/workspaces.create`);
      const createWorkspaceRes = await fetch(`${API_BASE}/workspaces.create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: workspaceId,
          name: workspaceName,
          settings: { timezone: 'UTC' }
        })
      });

      const workspaceData = await createWorkspaceRes.json();
      if (workspaceData.error && !workspaceData.error.includes('already exists')) {
        throw new Error(workspaceData.error);
      }
      addLog('success', `✅ Workspace created: ${workspaceId}`);

      // Step 4: Generate API key
      addLog('request', `POST ${API_BASE}/workspaces.createAPIKey`);
      const apiKeyRes = await fetch(`${API_BASE}/workspaces.createAPIKey`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          email_prefix: `api${Date.now()}`
        })
      });

      const apiKeyData = await apiKeyRes.json();
      if (!apiKeyData.token) throw new Error('No API key received');
      addLog('success', `✅ API Key generated`);

      // Step 5: Invite tenant admin
      const tenantAdminEmail = `admin-${workspaceId}@notifuse.local`;
      addLog('request', `POST ${API_BASE}/workspaces.inviteMember`);

      const inviteRes = await fetch(`${API_BASE}/workspaces.inviteMember`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
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
            webhooks: { read: true, write: true }
          }
        })
      });

      const inviteData = await inviteRes.json();
      if (!inviteData.token) throw new Error('No invitation token received');
      addLog('success', `✅ Tenant admin invited`);

      // Step 6: Accept invitation
      addLog('request', `POST ${API_BASE}/workspaces.acceptInvitation`);
      const acceptRes = await fetch(`${API_BASE}/workspaces.acceptInvitation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteData.token })
      });

      const acceptData = await acceptRes.json();
      if (!acceptData.user) throw new Error('User not created');
      addLog('success', `✅ User created`);

      // Step 7: Generate magic link
      addLog('request', `POST ${API_BASE}/user.signin`);
      const tenantSigninRes = await fetch(`${API_BASE}/user.signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: tenantAdminEmail })
      });

      const tenantSigninData = await tenantSigninRes.json();
      const magicLink = `${NOTIFUSE_BASE_URL}/console/signin?email=${encodeURIComponent(tenantAdminEmail)}&code=${tenantSigninData.code}`;

      addLog('success', '✅ Magic link generated');
      addLog('success', '🎉 TENANT CREATION COMPLETE!');

      setResult({
        workspaceId,
        workspaceName,
        apiKey: apiKeyData.token,
        apiEmail: apiKeyData.email,
        adminEmail: tenantAdminEmail,
        adminUserId: acceptData.user.id,
        magicCode: tenantSigninData.code,
        magicLink
      });

    } catch (error: any) {
      addLog('error', `❌ Error: ${error.message}`);
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setWorkspaceId('');
    setWorkspaceName('');
    setResult(null);
    setLogs([]);
    setShowLogs(false);
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className={styles.formGroup}>
          <label htmlFor="notifuse-id" className={styles.label}>
            Workspace ID
          </label>
          <input
            id="notifuse-id"
            type="text"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
            placeholder="acmecorp"
            className={styles.input}
            required
            pattern="[a-z0-9]+"
            maxLength={32}
            disabled={isLoading}
          />
          <p className="text-xs text-muted-foreground mt-1">Alphanumeric only, max 32 characters</p>
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="notifuse-name" className={styles.label}>
            Workspace Name
          </label>
          <input
            id="notifuse-name"
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="ACME Corporation"
            className={styles.input}
            required
            maxLength={32}
            disabled={isLoading}
          />
          <p className="text-xs text-muted-foreground mt-1">Display name, max 32 characters</p>
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isLoading}
            className={styles.button}
          >
            {isLoading ? 'Création en cours...' : '📧 Créer le workspace Notifuse'}
          </button>

          {!isLoading && logs.length > 0 && (
            <button
              type="button"
              onClick={resetForm}
              className={`${styles.button} ${styles.buttonSecondary}`}
            >
              Reset
            </button>
          )}
        </div>
      </form>

      {result && (
        <div className={`${styles.resultCard} ${styles.resultSuccess}`}>
          <h3 className={styles.resultTitle}>✅ Workspace Notifuse créé avec succès !</h3>

          <div className={styles.resultContent}>
            <div className="space-y-2">
              <div><strong>Workspace ID:</strong> {result.workspaceId}</div>
              <div><strong>API Email:</strong> {result.apiEmail}</div>
              <div><strong>Admin Email:</strong> {result.adminEmail}</div>
              <div><strong>Admin User ID:</strong> {result.adminUserId}</div>

              <div className="pt-3 border-t border-border">
                <a
                  href={result.magicLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition"
                >
                  🔗 Ouvrir Notifuse (Magic Link)
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {showLogs && logs.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="text-sm text-muted-foreground hover:text-foreground mb-2"
          >
            {showLogs ? '▼' : '▶'} Debug Logs ({logs.length})
          </button>

          {showLogs && (
            <div className={styles.logsPanel}>
              {logs.map((log, idx) => (
                <div
                  key={idx}
                  className={`${styles.logEntry} ${
                    log.level === 'success' ? styles.logSuccess :
                    log.level === 'error' ? styles.logError :
                    styles.logInfo
                  }`}
                >
                  [{log.timestamp.toLocaleTimeString()}] [{log.level.toUpperCase()}] {log.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

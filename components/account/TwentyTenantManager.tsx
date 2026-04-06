'use client';

import { useState } from 'react';
import styles from '@/app/(marketing)/account/account.module.css';

/**
 * TWENTY TENANT MANAGER
 *
 * Composant pour gérer la création de tenants Twenty CRM.
 * Réutilise la logique du POC twenty/page.tsx
 * 🔒 Conserve toute la logique backend
 */

interface LogEntry {
  timestamp: string;
  step: string;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: any;
}

interface WorkspaceResult {
  id: string;
  displayName: string;
  subdomain: string;
  activationStatus: string;
}

interface ApiKeyResult {
  token: string;
  expiresAt: string;
}

interface CredentialsResult {
  email: string;
  password: string;
}

export default function TwentyTenantManager() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceResult | null>(null);
  const [apiKey, setApiKey] = useState<ApiKeyResult | null>(null);
  const [credentials, setCredentials] = useState<CredentialsResult | null>(null);
  const [autoLoginUrl, setAutoLoginUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLogs([]);
    setWorkspace(null);
    setApiKey(null);
    setCredentials(null);
    setAutoLoginUrl(null);
    setIsLoading(true);
    setShowLogs(true);

    try {
      const response = await fetch('/api/twenty/create-tenant', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          workspaceName,
        }),
      });

      const data = await response.json();
      setLogs(data.logs || []);

      if (data.success) {
        setWorkspace(data.workspace);
        setApiKey(data.apiKey);
        setCredentials(data.credentials);
        setAutoLoginUrl(data.autoLoginUrl);
      }
    } catch (error: any) {
      setLogs([
        {
          timestamp: new Date().toISOString(),
          step: 'client-error',
          type: 'error',
          message: `Request failed: ${error.message}`,
          data: { error: error.message }
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAutoLogin = async () => {
    if (!credentials) {
      alert('Credentials manquants');
      return;
    }

    try {
      const response = await fetch('/api/twenty/regenerate-login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });

      const data = await response.json();

      if (data.success && data.autoLoginUrl) {
        window.open(data.autoLoginUrl, '_blank');
      } else {
        alert(`Erreur: ${data.error || 'Impossible de générer le lien de connexion'}`);
      }
    } catch (error: any) {
      alert(`Erreur: ${error.message}`);
    }
  };

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setWorkspaceName('');
    setLogs([]);
    setWorkspace(null);
    setApiKey(null);
    setCredentials(null);
    setAutoLoginUrl(null);
    setShowLogs(false);
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className={styles.formGroup}>
          <label htmlFor="twenty-email" className={styles.label}>
            Email
          </label>
          <input
            id="twenty-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="user@example.com"
            className={styles.input}
            disabled={isLoading}
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="twenty-password" className={styles.label}>
            Password
          </label>
          <input
            id="twenty-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="Minimum 8 caractères"
            className={styles.input}
            disabled={isLoading}
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="twenty-workspace" className={styles.label}>
            Workspace Name
          </label>
          <input
            id="twenty-workspace"
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            required
            placeholder="Mon Entreprise"
            className={styles.input}
            disabled={isLoading}
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isLoading}
            className={styles.button}
          >
            {isLoading ? 'Création en cours...' : '🚀 Créer le workspace Twenty'}
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

      {workspace && (
        <div className={`${styles.resultCard} ${styles.resultSuccess}`}>
          <h3 className={styles.resultTitle}>✅ Workspace Twenty créé avec succès !</h3>

          <div className={styles.resultContent}>
            <div className="space-y-2">
              <div>
                <strong>Workspace ID:</strong> {workspace.id}
              </div>
              <div>
                <strong>Display Name:</strong> {workspace.displayName}
              </div>
              <div>
                <strong>Status:</strong> {workspace.activationStatus}
              </div>

              {apiKey && (
                <div className="pt-2 border-t border-border">
                  <strong>API Key:</strong>
                  <div className="font-mono text-xs break-all mt-1 p-2 bg-muted rounded">
                    {apiKey.token}
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(apiKey.token)}
                    className="text-xs text-green-400 hover:underline mt-1"
                  >
                    📋 Copier
                  </button>
                </div>
              )}

              {credentials && (
                <div className="pt-2 border-t border-border">
                  <div><strong>Email:</strong> {credentials.email}</div>
                  <div><strong>Password:</strong> {credentials.password}</div>
                </div>
              )}

              <div className="pt-3 space-y-2">
                <button
                  onClick={handleAutoLogin}
                  disabled={!autoLoginUrl}
                  className={styles.button}
                >
                  🚀 Se connecter automatiquement
                </button>
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
                    log.type === 'success' ? styles.logSuccess :
                    log.type === 'error' ? styles.logError :
                    styles.logInfo
                  }`}
                >
                  [{log.type.toUpperCase()}] {log.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

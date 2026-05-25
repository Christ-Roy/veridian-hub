'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Mail, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

type Props = {
  isConnected: boolean;
  needsReauth: boolean;
};

export function MailSenderActions({ isConnected, needsReauth }: Props) {
  const router = useRouter();
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/gmail/test-send', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setTestResult({
          ok: true,
          message: `Mail envoyé (id: ${data.message_id})`,
        });
        router.refresh();
      } else {
        setTestResult({
          ok: false,
          message: data?.message || data?.error || 'Échec de l\'envoi',
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Erreur réseau',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Déconnecter votre Gmail ? Les envois cesseront immédiatement.')) {
      return;
    }
    setDisconnecting(true);
    try {
      await fetch('/api/gmail/disconnect', { method: 'POST' });
      router.refresh();
    } finally {
      setDisconnecting(false);
    }
  }

  if (!isConnected && !needsReauth) {
    return (
      <div className="flex gap-2">
        <Button asChild>
          <a href="/api/gmail/connect">
            <Mail className="mr-2 h-4 w-4" />
            Connecter mon Gmail
          </a>
        </Button>
      </div>
    );
  }

  if (needsReauth) {
    return (
      <div className="flex gap-2">
        <Button asChild variant="default">
          <a href="/api/gmail/connect">
            <RefreshCw className="mr-2 h-4 w-4" />
            Reconnecter
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button onClick={handleTest} disabled={testing}>
          {testing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Mail className="mr-2 h-4 w-4" />
          )}
          Tester l&apos;envoi
        </Button>
        <Button
          variant="outline"
          onClick={handleDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="mr-2 h-4 w-4" />
          )}
          Déconnecter
        </Button>
      </div>
      {testResult && (
        <div
          className={
            testResult.ok
              ? 'rounded-md border border-success/40 bg-success/5 p-3 text-sm text-success'
              : 'rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'
          }
          role="status"
        >
          {testResult.message}
        </div>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useEnv } from '@/contexts/EnvContext';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, ExternalLink, Info } from 'lucide-react';

interface TenantCardProps {
  service: 'notifuse';
  configured: boolean;
  available?: boolean;
  slug?: string;
  userEmail?: string;
  tenantId?: string;
}

export function TenantCard({
  service: _service,
  configured,
  available = true,
  slug,
  userEmail: _userEmail,
  tenantId,
}: TenantCardProps) {
  const env = useEnv();
  const [loading, setLoading] = useState(false);

  const serviceName = 'Notifuse';
  const serviceIcon = '📧';
  const serviceDescription = 'Email & Notification Service';

  const handleOpenService = async () => {
    setLoading(true);

    try {
      if (!tenantId) {
        const fallback = (env.NEXT_PUBLIC_NOTIFUSE_URL || 'https://notifuse.app.veridian.site') + '/console';
        window.open(fallback, '_blank');
        toast.info('Manual login', {
          description: 'Workspace not fully provisioned yet — opening console.',
        });
        return;
      }

      const res = await fetch('/api/admin/notifuse/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      const data = await res.json();

      const targetUrl = data.autoLoginUrl || data.magicLink;
      if (!res.ok || !targetUrl) {
        const fallback = (env.NEXT_PUBLIC_NOTIFUSE_URL || 'https://notifuse.app.veridian.site') + '/console';
        window.open(fallback, '_blank');
        toast.error('Auto-login unavailable', {
          description: data.error || 'Opening console without auto-login.',
          duration: 5000,
        });
        return;
      }

      window.open(targetUrl, '_blank');
    } catch (error: any) {
      console.error('Error opening service:', error);
      toast.error('Error opening service', {
        description: error.message,
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="hover:shadow-lg transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <span className="text-2xl">{serviceIcon}</span>
              <span>{serviceName}</span>
            </CardTitle>
            <CardDescription className="mt-1">
              {serviceDescription}
            </CardDescription>
          </div>
          {configured && (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
              ✅ Active
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {configured ? (
          <div className="space-y-2">
            {slug && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Workspace:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs">
                  {slug}
                </code>
              </div>
            )}

            <div className="flex items-start gap-2 mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <Info className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-blue-900 space-y-2">
                <div>
                  <strong>Workspace: {slug}</strong>
                </div>
                <div>
                  Click &ldquo;Open&rdquo; to log in automatically with a fresh magic link
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <p>Workspace will be created automatically</p>
            <p className="text-xs mt-1">when you sign up to the dashboard</p>
          </div>
        )}
      </CardContent>

      <CardFooter>
        {configured ? (
          <div className="w-full space-y-2">
            <Button
              onClick={handleOpenService}
              disabled={loading}
              className="w-full"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Opening...
                </>
              ) : (
                <>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  🔗 Open {serviceName}
                </>
              )}
            </Button>
          </div>
        ) : !available ? (
          <Button disabled className="w-full" variant="outline" size="lg">
            Not available in this environment
          </Button>
        ) : (
          <Button disabled className="w-full" variant="outline" size="lg">
            ⏳ Provisioning...
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

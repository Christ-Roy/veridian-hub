'use client';

import { useState } from 'react';
import { toast } from 'sonner';
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
import { Loader2, ExternalLink, Info, RefreshCw } from 'lucide-react';

interface ProspectionCardProps {
  configured: boolean;
  loginUrl?: string | null;
  tokenValid: boolean;
  plan?: string;
}

export function ProspectionCard({
  configured,
  loginUrl,
  tokenValid,
  plan = 'freemium',
}: ProspectionCardProps) {
  const [loading, setLoading] = useState(false);

  const planLabel = plan === 'freemium' ? 'Free (300 prospects)' : plan === 'pro' ? 'Pro (illimite)' : plan;

  const handleOpen = async () => {
    setLoading(true);
    try {
      if (tokenValid && loginUrl) {
        // Token still valid — open directly
        window.open(loginUrl, '_blank');
      } else {
        // Token expired or used — regenerate
        const res = await fetch('/api/prospection/regenerate-login', {
          method: 'POST',
        });
        const data = await res.json();

        if (!res.ok || !data.login_url) {
          toast.error('Failed to generate login link', {
            description: data.error || 'Unknown error',
            duration: 5000,
          });
          return;
        }

        window.open(data.login_url, '_blank');
      }
    } catch (error: any) {
      console.error('Error opening Prospection:', error);
      toast.error('Error', {
        description: error.message || 'Failed to open Prospection',
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
              <span className="text-2xl">🎯</span>
              <span>Prospection</span>
            </CardTitle>
            <CardDescription className="mt-1">
              Qualification de leads .fr
            </CardDescription>
          </div>
          {configured && (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
              Active
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {configured ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Plan:</span>
              <code className="bg-muted px-2 py-1 rounded text-xs">
                {planLabel}
              </code>
            </div>

            <div className="flex items-start gap-2 mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <Info className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-blue-900">
                {tokenValid ? (
                  <span>
                    <strong>Auto-login enabled</strong> — Click to open your dashboard
                  </span>
                ) : (
                  <span>
                    <strong>New login link will be generated</strong> — Click below to access your dashboard
                  </span>
                )}
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
          <Button
            onClick={handleOpen}
            disabled={loading}
            className="w-full"
            size="lg"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {tokenValid ? 'Opening...' : 'Generating link...'}
              </>
            ) : (
              <>
                <ExternalLink className="mr-2 h-4 w-4" />
                {tokenValid ? 'Open Prospection' : 'Open Prospection'}
              </>
            )}
          </Button>
        ) : (
          <Button disabled className="w-full" variant="outline" size="lg">
            Provisioning...
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

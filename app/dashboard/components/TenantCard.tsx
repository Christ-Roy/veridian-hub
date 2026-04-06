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
  service: 'twenty' | 'notifuse';
  configured: boolean;
  available?: boolean;
  subdomain?: string;
  slug?: string;
  loginTokenValid?: boolean;
  loginToken?: string;
  invitationSent?: boolean;
  userEmail?: string;
}

export function TenantCard({
  service,
  configured,
  available = true,
  subdomain,
  slug,
  loginTokenValid,
  loginToken,
  invitationSent = false,
  userEmail,
}: TenantCardProps) {
  const env = useEnv();
  const [loading, setLoading] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [localInvitationSent, setLocalInvitationSent] = useState(invitationSent);

  const serviceName = service === 'twenty' ? 'Twenty CRM' : 'Notifuse';
  const serviceIcon = service === 'twenty' ? '📊' : '📧';
  const serviceDescription =
    service === 'twenty'
      ? 'Customer Relationship Management'
      : 'Email & Notification Service';

  const handleSendInvitation = async () => {
    setInviting(true);
    try {
      const response = await fetch('/api/notifuse/invite-member', {
        method: 'POST',
      });

      const data = await response.json();

      if (data.success) {
        setLocalInvitationSent(true);
        if (data.alreadyMember) {
          toast.success('Already a member', {
            description: 'You are already a member of this workspace. Use the Open button to access it.',
            duration: 5000,
          });
        } else {
          toast.success('Invitation sent!', {
            description: `Check your email (${data.email}) for the invitation link.`,
            duration: 5000,
          });
        }
      } else {
        toast.error('Failed to send invitation', {
          description: data.error || 'Unknown error',
          duration: 5000,
        });
      }
    } catch (error: any) {
      console.error('Error sending invitation:', error);
      toast.error('Error', {
        description: error.message || 'Failed to send invitation',
        duration: 5000,
      });
    } finally {
      setInviting(false);
    }
  };

  const handleOpenService = () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[TenantCard] Opening ${service}`, {
        configured,
        subdomain,
        slug,
        loginTokenValid,
        hasLoginToken: !!loginToken,
      });
    }

    setLoading(true);

    try {
      if (service === 'twenty') {
        if (loginTokenValid && loginToken && subdomain) {
          // Auto-login avec magic link
          const twentyBaseUrl = env.NEXT_PUBLIC_TWENTY_URL || 'https://twenty.app.veridian.site';
          // Support HTTP et HTTPS pour insérer le subdomain
          const magicLink = twentyBaseUrl
            .replace(/^(https?:\/\/)/, `$1${subdomain}.`)
            + `/verify?loginToken=${loginToken}`;
          if (process.env.NODE_ENV !== 'production') {
            console.log('[TenantCard] Opening Twenty with auto-login:', magicLink);
          }
          window.open(magicLink, '_blank');
        } else {
          // Login manuel - redirection vers /welcome avec email pré-rempli
          const twentyBaseUrl = env.NEXT_PUBLIC_TWENTY_URL || 'https://twenty.app.veridian.site';
          const baseUrlWithSubdomain = subdomain
            ? twentyBaseUrl.replace(/^(https?:\/\/)/, `$1${subdomain}.`)
            : twentyBaseUrl;

          // Ajouter l'email en query parameter si disponible
          const emailParam = userEmail ? `?email=${encodeURIComponent(userEmail)}` : '';
          const manualUrl = `${baseUrlWithSubdomain}/welcome${emailParam}`;

          if (process.env.NODE_ENV !== 'production') {
            console.log('[TenantCard] Opening Twenty with manual login:', manualUrl);
          }
          window.open(manualUrl, '_blank');

          // Info message
          setTimeout(() => {
            toast.info('Manual login required', {
              description: `Please login manually with your dashboard password.\n\nYour workspace subdomain: ${subdomain}`,
              duration: 5000,
            });
          }, 500);
        }
      } else {
        // Notifuse - toujours login manuel (pas de loginToken)
        const notifuseUrl = (env.NEXT_PUBLIC_NOTIFUSE_URL || 'https://notifuse.app.veridian.site') + '/console';
        if (process.env.NODE_ENV !== 'production') {
          console.log('[TenantCard] Opening Notifuse console:', notifuseUrl);
        }
        window.open(notifuseUrl, '_blank');

        setTimeout(() => {
          toast.info('Magic link login', {
            description: `Please request a magic link with your email.\n\nYour workspace: ${slug}`,
            duration: 5000,
          });
        }, 500);
      }
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
            {subdomain && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Workspace:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs">
                  {subdomain}
                </code>
              </div>
            )}
            {slug && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Workspace:</span>
                <code className="bg-muted px-2 py-1 rounded text-xs">
                  {slug}
                </code>
              </div>
            )}

            {service === 'twenty' && (
              <div className="flex items-start gap-2 mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <Info className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-blue-900">
                  {loginTokenValid ? (
                    <span>
                      <strong>Auto-login enabled</strong> - You'll be logged in
                      automatically
                    </span>
                  ) : (
                    <span>
                      <strong>Manual login required</strong> - Use your dashboard
                      password to login
                    </span>
                  )}
                </div>
              </div>
            )}

            {service === 'notifuse' && (
              <div className="flex items-start gap-2 mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <Info className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-blue-900 space-y-2">
                  <div>
                    <strong>Workspace: {slug}</strong>
                  </div>
                  <div>
                    Click "Send Invitation" below to receive an email with access to your workspace
                  </div>
                </div>
              </div>
            )}
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
            {service === 'notifuse' && !localInvitationSent && (
              <Button
                onClick={handleSendInvitation}
                disabled={inviting}
                className="w-full"
                variant="outline"
                size="lg"
              >
                {inviting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    📧 Send Invitation Email
                  </>
                )}
              </Button>
            )}
            {service === 'notifuse' && localInvitationSent && (
              <div className="w-full p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 text-center">
                ✅ Invitation sent! Check your email
              </div>
            )}
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
                  {loginTokenValid ? '🚀 Open (Auto-login)' : '🔗 Open ' + serviceName}
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

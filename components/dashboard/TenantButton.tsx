'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ServiceType = 'twenty' | 'notifuse';

interface Tenant {
  id: string;
  twenty_workspace_id?: string | null;
  twenty_user_email?: string | null;
  twenty_user_password?: string | null;
  notifuse_workspace_slug?: string | null;
  notifuse_user_email?: string | null;
}

interface TenantButtonProps {
  service: ServiceType;
  tenant: Tenant | null;
  onCreateTenant: (service: ServiceType) => void;
  onConnect: (service: ServiceType) => void;
  isCreating?: boolean;
}

const serviceConfig = {
  twenty: {
    name: 'Twenty CRM',
    icon: '📇',
    description: 'Manage your customer relationships',
    buttonClass: 'bg-primary text-primary-foreground hover:bg-primary/90',
    url: process.env.NEXT_PUBLIC_TWENTY_URL || '',
  },
  notifuse: {
    name: 'Notifuse',
    icon: '📧',
    description: 'Email marketing automation',
    buttonClass: 'bg-secondary text-secondary-foreground hover:bg-secondary/90',
    url: process.env.NEXT_PUBLIC_NOTIFUSE_URL || '',
  },
};

export default function TenantButton({ service, tenant, onCreateTenant, onConnect, isCreating = false }: TenantButtonProps) {
  const config = serviceConfig[service];

  // Vérifier si le tenant existe pour ce service
  const hasTenant = service === 'twenty'
    ? !!tenant?.twenty_workspace_id
    : !!tenant?.notifuse_workspace_slug;

  const handleClick = () => {
    if (hasTenant) {
      onConnect(service);
    } else {
      onCreateTenant(service);
    }
  };

  return (
    <Card className="hover:shadow-lg transition-all hover:scale-[1.02] cursor-pointer">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-5xl">{config.icon}</div>
            <div>
              <CardTitle className="text-2xl">{config.name}</CardTitle>
              <CardDescription className="text-base">{config.description}</CardDescription>
            </div>
          </div>
          <div
            className={`px-4 py-2 rounded-full text-sm font-semibold ${
              hasTenant
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'bg-muted text-muted-foreground border border-border'
            }`}
          >
            {hasTenant ? '✓ Active' : 'Not configured'}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          className={`w-full ${config.buttonClass} font-semibold`}
          size="lg"
          onClick={handleClick}
          disabled={isCreating}
        >
          {isCreating ? (
            <>
              <span className="mr-2 animate-spin">⏳</span>
              {hasTenant ? 'Opening...' : 'Creating...'}
            </>
          ) : hasTenant ? (
            <>
              <span className="mr-2">🚀</span>
              Open {config.name}
            </>
          ) : (
            <>
              <span className="mr-2">✨</span>
              Create Workspace
            </>
          )}
        </Button>

        {hasTenant && (
          <div className="pt-2 border-t text-sm text-muted-foreground space-y-1">
            <div className="flex justify-between">
              <span className="font-medium">Email:</span>
              <span>{service === 'twenty' ? tenant?.twenty_user_email : tenant?.notifuse_user_email}</span>
            </div>
            {service === 'twenty' && tenant?.twenty_workspace_id && (
              <div className="flex justify-between">
                <span className="font-medium">Workspace ID:</span>
                <span className="font-mono text-xs">{tenant.twenty_workspace_id.slice(0, 8)}...</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

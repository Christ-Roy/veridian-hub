'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/utils/supabase/client';

type ServiceType = 'twenty' | 'notifuse';

interface CreateTenantModalProps {
  service: ServiceType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const serviceConfig = {
  twenty: {
    name: 'Twenty CRM',
    icon: '📇',
    fields: [
      { name: 'email', label: 'Email', type: 'email', placeholder: 'user@example.com' },
      { name: 'password', label: 'Password', type: 'password', placeholder: 'Minimum 8 characters' },
      { name: 'workspaceName', label: 'Workspace Name', type: 'text', placeholder: 'My Company' },
    ],
  },
  notifuse: {
    name: 'Notifuse',
    icon: '📧',
    fields: [
      { name: 'workspaceId', label: 'Workspace ID', type: 'text', placeholder: 'acmecorp' },
      { name: 'workspaceName', label: 'Workspace Name', type: 'text', placeholder: 'ACME Corporation' },
    ],
  },
};

export default function CreateTenantModal({ service, open, onOpenChange, onSuccess }: CreateTenantModalProps) {
  const router = useRouter();
  const config = serviceConfig[service];
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const apiUrl = service === 'twenty'
        ? '/api/twenty/create-tenant'
        : '/api/notifuse/create-tenant';

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (data.success) {
        // Enregistrer le tenant en base Supabase
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
          const tenantData: any = {
            user_id: user.id,
            name: formData.workspaceName || formData.workspaceId,
            slug: formData.workspaceId || `${service}-${Date.now()}`,
            status: 'active',
          };

          if (service === 'twenty') {
            tenantData.twenty_workspace_id = data.workspace.id;
            tenantData.twenty_user_email = formData.email;
            tenantData.twenty_user_password = formData.password;
            tenantData.twenty_api_key = data.apiKey?.token;
          } else {
            tenantData.notifuse_workspace_slug = formData.workspaceId;
            tenantData.notifuse_user_email = data.result?.adminEmail;
            tenantData.notifuse_api_key = data.result?.apiKey;
          }

          await supabase.from('tenants').upsert(tenantData as any);
        }

        onSuccess();
        onOpenChange(false);
        setFormData({});
      } else {
        setError(data.error || 'Failed to create workspace');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-2xl">{config.icon}</span>
            Create {config.name} Workspace
          </DialogTitle>
          <DialogDescription>
            Fill in the details to create your new {config.name} workspace.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          {config.fields.map((field) => (
            <div key={field.name} className="space-y-2">
              <Label htmlFor={field.name}>{field.label}</Label>
              <Input
                id={field.name}
                name={field.name}
                type={field.type}
                placeholder={field.placeholder}
                value={formData[field.name] || ''}
                onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                required
                disabled={isLoading}
              />
            </div>
          ))}

          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="flex-1" loading={isLoading}>
              {isLoading ? 'Creating...' : 'Create Workspace'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

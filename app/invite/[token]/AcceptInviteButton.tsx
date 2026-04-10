'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import type { WorkspaceRole } from '@/types/workspace';

interface AcceptInviteButtonProps {
  token: string;
  invitationId: string;
  workspaceId: string;
  role: WorkspaceRole;
  userId: string;
}

export function AcceptInviteButton({ token }: AcceptInviteButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleAccept() {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? 'Erreur lors de l\'acceptation');
        return;
      }

      router.push(`/invite/${token}?accepted=1`);
    } catch {
      toast.error('Erreur réseau, veuillez réessayer');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleAccept} disabled={loading} className="w-full">
      {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
      Accepter l'invitation
    </Button>
  );
}

'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { MemberActions } from './MemberActions';
import type { WorkspaceMember, WorkspaceRole } from '@/types/workspace';
import { WORKSPACE_ROLE_LABELS } from '@/types/workspace';

interface MembersTableProps {
  members: WorkspaceMember[];
  actorRole: WorkspaceRole;
  actorUserId: string;
  onUpdated?: () => void;
}

function getInitials(email: string, name?: string | null): string {
  if (name) return name.slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

const ROLE_BADGE_VARIANT: Record<WorkspaceRole, 'default' | 'secondary' | 'outline'> = {
  OWNER: 'default',
  ADMIN: 'secondary',
  MEMBER: 'outline',
  VIEWER: 'outline',
};

export function MembersTable({ members, actorRole, actorUserId, onUpdated }: MembersTableProps) {
  if (members.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Aucun membre dans ce workspace.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Membre</TableHead>
          <TableHead>Rôle</TableHead>
          <TableHead>Rejoint le</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const isActor = member.userId === actorUserId;
          return (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs">
                      {getInitials(member.email, member.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">
                      {member.name ?? member.email}
                      {isActor && <span className="ml-2 text-xs text-muted-foreground">(vous)</span>}
                    </span>
                    {member.name && (
                      <span className="text-xs text-muted-foreground">{member.email}</span>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={ROLE_BADGE_VARIANT[member.role]}>
                  {WORKSPACE_ROLE_LABELS[member.role]}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {member.joinedAt
                  ? new Date(member.joinedAt).toLocaleDateString('fr-FR')
                  : <span className="italic">Invitation envoyée</span>}
              </TableCell>
              <TableCell className="text-right">
                {isActor ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <MemberActions
                    memberId={member.id}
                    memberEmail={member.email}
                    memberRole={member.role}
                    actorRole={actorRole}
                    onUpdated={onUpdated}
                  />
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

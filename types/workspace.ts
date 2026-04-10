// Types workspace — P1.5
// Calqués sur les modèles Prisma à venir (schema hub_app)

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export const WORKSPACE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: 'Propriétaire',
  ADMIN: 'Administrateur',
  MEMBER: 'Membre',
  VIEWER: 'Observateur',
};

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  email: string;
  name?: string | null;
  role: WorkspaceRole;
  invitedAt: string;
  joinedAt?: string | null;
}

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  expiresAt: string;
  acceptedAt?: string | null;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

// Droits par rôle
export function canInviteMembers(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function canChangeRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  if (actorRole === 'OWNER') return targetRole !== 'OWNER'; // owner peut tout sauf changer son propre owner
  if (actorRole === 'ADMIN') return targetRole !== 'OWNER' && targetRole !== 'ADMIN'; // admin change member/viewer
  return false;
}

export function canRemoveMember(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  if (actorRole === 'OWNER') return targetRole !== 'OWNER';
  if (actorRole === 'ADMIN') return targetRole === 'MEMBER' || targetRole === 'VIEWER';
  return false;
}

import { describe, it, expect } from 'vitest';
import {
  canInviteMembers,
  canChangeRole,
  canRemoveMember,
  WORKSPACE_ROLE_LABELS,
  WORKSPACE_ROLES,
} from '@/types/workspace';
import type { WorkspaceRole } from '@/types/workspace';

describe('workspace roles — labels', () => {
  it('a un label pour chaque rôle', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(WORKSPACE_ROLE_LABELS[role]).toBeTruthy();
    }
  });
});

describe('canInviteMembers', () => {
  it('OWNER peut inviter', () => {
    expect(canInviteMembers('OWNER')).toBe(true);
  });

  it('ADMIN peut inviter', () => {
    expect(canInviteMembers('ADMIN')).toBe(true);
  });

  it('MEMBER ne peut pas inviter', () => {
    expect(canInviteMembers('MEMBER')).toBe(false);
  });

  it('VIEWER ne peut pas inviter', () => {
    expect(canInviteMembers('VIEWER')).toBe(false);
  });
});

describe('canChangeRole', () => {
  it('OWNER peut changer ADMIN en MEMBER', () => {
    expect(canChangeRole('OWNER', 'ADMIN')).toBe(true);
  });

  it('OWNER peut changer MEMBER en ADMIN', () => {
    expect(canChangeRole('OWNER', 'MEMBER')).toBe(true);
  });

  it('OWNER ne peut pas changer un autre OWNER', () => {
    // protection contre le transfert non-intentionnel
    expect(canChangeRole('OWNER', 'OWNER')).toBe(false);
  });

  it('ADMIN peut changer MEMBER', () => {
    expect(canChangeRole('ADMIN', 'MEMBER')).toBe(true);
  });

  it('ADMIN peut changer VIEWER', () => {
    expect(canChangeRole('ADMIN', 'VIEWER')).toBe(true);
  });

  it('ADMIN ne peut pas changer un autre ADMIN', () => {
    expect(canChangeRole('ADMIN', 'ADMIN')).toBe(false);
  });

  it('ADMIN ne peut pas changer un OWNER', () => {
    expect(canChangeRole('ADMIN', 'OWNER')).toBe(false);
  });

  it('MEMBER ne peut pas changer de rôle', () => {
    const roles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    for (const target of roles) {
      expect(canChangeRole('MEMBER', target)).toBe(false);
    }
  });

  it('VIEWER ne peut pas changer de rôle', () => {
    const roles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    for (const target of roles) {
      expect(canChangeRole('VIEWER', target)).toBe(false);
    }
  });
});

describe('canRemoveMember', () => {
  it('OWNER peut retirer ADMIN', () => {
    expect(canRemoveMember('OWNER', 'ADMIN')).toBe(true);
  });

  it('OWNER peut retirer MEMBER', () => {
    expect(canRemoveMember('OWNER', 'MEMBER')).toBe(true);
  });

  it('OWNER peut retirer VIEWER', () => {
    expect(canRemoveMember('OWNER', 'VIEWER')).toBe(true);
  });

  it('OWNER ne peut pas se retirer lui-même (rôle OWNER)', () => {
    expect(canRemoveMember('OWNER', 'OWNER')).toBe(false);
  });

  it('ADMIN peut retirer MEMBER', () => {
    expect(canRemoveMember('ADMIN', 'MEMBER')).toBe(true);
  });

  it('ADMIN peut retirer VIEWER', () => {
    expect(canRemoveMember('ADMIN', 'VIEWER')).toBe(true);
  });

  it('ADMIN ne peut pas retirer un OWNER', () => {
    expect(canRemoveMember('ADMIN', 'OWNER')).toBe(false);
  });

  it('ADMIN ne peut pas retirer un autre ADMIN', () => {
    expect(canRemoveMember('ADMIN', 'ADMIN')).toBe(false);
  });

  it('MEMBER ne peut retirer personne', () => {
    const roles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    for (const target of roles) {
      expect(canRemoveMember('MEMBER', target)).toBe(false);
    }
  });

  it('VIEWER ne peut retirer personne', () => {
    const roles: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    for (const target of roles) {
      expect(canRemoveMember('VIEWER', target)).toBe(false);
    }
  });
});

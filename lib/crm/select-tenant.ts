// STUB temporaire — Agent A doit livrer la version réelle (lecture Prisma
// CrmTenant via userId). En attendant, on retourne null pour que la page
// /dashboard/crm rende l'état "à activer".
//
// Quand Agent A push :
// - schema.prisma : modèle CrmTenant { id, userId, twentyWorkspaceId,
//   apiKeyEncrypted, status, createdAt, updatedAt }
// - cette implémentation lit `prisma.crmTenant.findFirst({ where: { userId,
//   deletedAt: null }})`
//
// Le shape exporté ci-dessous est le contrat consommé par /dashboard/crm.

export type CrmTenantStatus = 'provisioning' | 'active' | 'suspended' | 'error';

export interface CrmTenantView {
  id: string;
  twentyWorkspaceId: string;
  status: CrmTenantStatus;
  createdAt: Date;
}

export async function getCrmTenantByUserId(
  _userUuid: string,
): Promise<CrmTenantView | null> {
  // TODO(agent-A): brancher sur prisma.crmTenant.findFirst
  return null;
}

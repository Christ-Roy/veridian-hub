/**
 * Relevé en lecture seule des organisations réglées au Hub (VER-252) : une app cochée n'est pas à jour. Rien n'est écrit, et aucune
 * adresse n'est rendue. Une organisation suspendue ou supprimée n'est pas comptée : rien ne lui est émis.
 */
import type { PrismaClient } from '@prisma/client';

import { contenuOrg, MODULES, type Module } from '@/lib/organisations/document';
import { hubPublicUrl } from '@/lib/organisations/base';

export type OrgEnRetard = { hub_tenant_id: string; app: Module; raison: 'pas_d_emission' | 'etat_non_applique' | 'version_differente' | 'contenu_non_emis'; etat?: string };
type Db = Pick<PrismaClient, 'organisation' | 'organisationEmission' | 'tenant' | 'tenantMember' | 'user'>;

export async function organisationsEnRetard(p: Db, env: NodeJS.ProcessEnv = process.env): Promise<OrgEnRetard[]> {
  const orgs = await p.organisation.findMany({ select: { tenantId: true } });
  const out: OrgEnRetard[] = [];
  for (const { tenantId } of orgs) {
    const c = await contenuOrg(p, tenantId, hubPublicUrl(env));
    if (!c) continue;
    const emis = await p.organisationEmission.findMany({ where: { tenantId } });
    for (const app of MODULES.filter((m) => c.contenu.modules.includes(m))) {
      const e = emis.find((x) => x.app === app);
      const retard = (raison: OrgEnRetard['raison'], etat?: string) => out.push({ hub_tenant_id: tenantId, app, raison, ...(etat ? { etat } : {}) });
      if (!e) retard('pas_d_emission');
      else if (e.etat !== 'applique') retard('etat_non_applique', e.etat);
      else if (e.version !== c.version) retard('version_differente');
      else if (c.empreinte !== c.empreinteStockee) retard('contenu_non_emis');
    }
  }
  return out;
}

/**
 * « Inclus avec votre site web » ne parle qu'à qui a un site Veridian (VER-105) : un plan vitrine, ou l'un des deux services du site déjà servi.
 * Sans site, la section promettait une chose que la personne n'a pas.
 */
export function montrerInclusAvecSite(o: { plan: boolean; analytics: boolean; cms: boolean }): boolean {
  const aUnSite = o.plan || o.analytics || o.cms;
  return aUnSite && !(o.analytics && o.cms);
}

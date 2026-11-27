/**
 * « Inclus avec votre site web » ne parle qu'à qui a un site Veridian (VER-105) : un plan vitrine, ou l'un des deux services du site déjà servi.
 * Sans site, la section promettait une chose que la personne n'a pas.
 */
export function montrerInclusAvecSite(o: { plan: boolean; analytics: boolean; cms: boolean }): boolean {
  const aUnSite = o.plan || o.analytics || o.cms;
  // Le CMS s'éteint (26/11) : il ne se propose plus ; seule Analytics reste à proposer, tant qu'elle n'est pas servie.
  return aUnSite && !o.analytics;
}

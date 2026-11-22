/**
 * Règles du catalogue Stripe local (hub_app.products, hub_app.prices), sans effet de bord : testées par
 * __tests__/scripts/stripe-catalogue.test.ts. Ce catalogue ne sert qu'à recevoir les abonnements (clé
 * étrangère subscriptions.price_id) : un prix absent faisait perdre l'abonnement en silence (22/11).
 */

/**
 * Produit Veridian : `namespace=veridian`, ou un bundle marqué `veridian_plan` (Veridian Pro et
 * Business n'ont que ce champ), ou l'ancien produit de base. Le compte Stripe porte aussi les boutiques
 * des clients (ASD…) : on ne les recopie pas.
 */
export function estProduitVeridian(product) {
  const m = (product && product.metadata) || {};
  return m.namespace === 'veridian' || Boolean(m.veridian_plan) || (m.productKey === 'BASE_PRODUCT' && !m.namespace);
}

/**
 * Toutes les pages d'une liste Stripe, pas seulement les 100 premiers éléments (le compte de test en
 * avait plus de 100 le 22/11 : « Veridian Pro » n'était jamais lu). `lister(params)` appelle l'API.
 */
export async function listerTout(lister, params = {}, plafondPages = 200) {
  const tout = [];
  let apres;
  for (let page = 0; page < plafondPages; page++) {
    const r = await lister({ limit: 100, ...params, ...(apres ? { starting_after: apres } : {}) });
    tout.push(...r.data);
    if (!r.has_more || r.data.length === 0) return tout;
    apres = r.data[r.data.length - 1].id;
  }
  throw new Error(`liste Stripe : plus de ${plafondPages} pages, arrêt`);
}

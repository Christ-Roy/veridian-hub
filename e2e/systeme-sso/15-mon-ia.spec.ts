/**
 * « Mon IA », moteur `cle-api`, de bout en bout sur ce qui est servi (docs/MON-IA.md) : un compte de test branche
 * une clé, allume l'assistant, pose une question ; l'IA lit une donnée réelle par la porte MCP (hub.mon_compte) et
 * la clé n'apparaît nulle part dans ce qui revient au navigateur.
 *
 * Coût nul : clé OpenRouter de Veridian sur un modèle `:free` (0 $ par jeton). Le branchement est retiré à la fin ;
 * le compte, par le nettoyage de la batterie.
 * Épreuve : `SSO_SABOTAGE=mon-ia-eteint` n'allume pas l'assistant : le cas doit échouer (403 chat_desactive).
 */
import { cas, NonAbouti } from './lib/etat';
import { HUB_URL } from './lib/cibles';
import { lookup, secretDe } from './lib/hub-admin';
import { compte, contexteDe } from './lib/monde';

const MODELE_GRATUIT = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // appel d'outil vérifié à 0 $ le 22/11

cas(null, 'Mon IA : une question lit une donnée réelle par la porte, la clé ne fuit pas', async ({ browser }) => {
  const cle = secretDe('OPENROUTER_API_KEY');
  const A = await compte(browser, 'A');
  const tenantId: string | undefined = A.tenantId ?? (await lookup(A.email)).json?.tenants?.[0]?.id;
  if (!tenantId) throw new NonAbouti('compte de test sans tenant Hub');
  const ctx = await contexteDe(browser, A);
  try {
    const api = ctx.request;
    const b = await api.post(`${HUB_URL}/api/ia/branchement`, { data: { fournisseur: 'openrouter', modele: MODELE_GRATUIT, cle } });
    if (b.status() !== 200) throw new Error(`branchement refusé : HTTP ${b.status()} ${(await b.text()).slice(0, 120)}`);
    const vue = await b.text();
    if (vue.includes(cle)) throw new Error('la clé revient en clair dans la réponse du branchement');

    if (process.env.SSO_SABOTAGE !== 'mon-ia-eteint') {
      const a = await api.post(`${HUB_URL}/api/ia/activation`, { data: { app: 'academy', tenantId, enabled: true } });
      if (a.status() !== 200) throw new Error(`activation refusée : HTTP ${a.status()}`);
    }

    const question = {
      app: 'academy',
      tenantId,
      messages: [{ id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Quels sont mes plans Veridian ? Utilise hub.mon_compte par les outils, puis réponds en une phrase.' }] }],
    };
    const r = await api.post(`${HUB_URL}/api/ia/chat`, { data: question, timeout: 120_000 });
    const flux = await r.text();
    if (r.status() === 429) throw new NonAbouti('plafond du fournisseur gratuit atteint : cas non joué');
    if (r.status() !== 200) throw new Error(`chat : HTTP ${r.status()} ${flux.slice(0, 160)}`);
    if (flux.includes(cle)) throw new Error('la clé apparaît dans le flux du chat');
    if (!/executer_outil|hub\.mon_compte/.test(flux)) throw new Error(`aucun appel d'outil de la porte dans le flux : ${flux.slice(0, 300)}`);
    if (!/"sessionId"/.test(flux)) throw new Error("le Hub n'a pas rendu d'identifiant de session");
    // La donnée réelle : le plan Mail du compte, tel que le Hub le tient.
    const plan = (await lookup(A.email)).json?.tenants?.[0]?.notifusePlan;
    if (plan && !new RegExp(String(plan), 'i').test(flux)) throw new Error(`la réponse ne reprend pas le plan réel (${plan})`);
    return `outil de la porte appelé, plan réel « ${plan ?? '?'} » dans la réponse, clé absente du flux`;
  } finally {
    await ctx.request.delete(`${HUB_URL}/api/ia/branchement?fournisseur=openrouter`).catch(() => undefined);
    await ctx.close();
  }
}, { timeout: 300_000 });

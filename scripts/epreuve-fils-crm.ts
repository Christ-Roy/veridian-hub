/**
 * Épreuve signée du plugin CRM « Assistant Veridian » (docs/MON-IA.md, « Le CRM »), contre l'espace servi.
 * Signe comme le Hub (lib/ia/fils.ts, lib/ia/espace-crm.ts) avec sa vraie clé et n'affiche que des codes HTTP et
 * la raison rendue par le plugin. La clé n'est jamais affichée : MCP_SIGNING_JWK de l'environnement, sinon lue
 * dans la Nomad Variable nomad/jobs/hub par `nomad-v` (sortie capturée, jamais écrite).
 *
 *   pnpm tsx scripts/epreuve-fils-crm.ts <origine> [<workspace_id>] [<hub_user_id>]
 *   ex. pnpm tsx scripts/epreuve-fils-crm.ts https://veridian-4.crm.app.veridian.site
 *
 * Sans workspace_id, il est demandé à la route espace du plugin. Le fil d'épreuve s'appelle epreuve-ver203-<horodatage>.
 * Code de sortie : 0 tout conforme, 1 au moins un écart, 2 non abouti (clé ou plugin injoignable).
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import { signerPourRouteApp } from '../lib/mcp/identite';
import { origineCrmValide } from '../lib/ia/fils';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const EN_TETE = 'x-veridian-ia-jeton';

async function main(): Promise<number> {
  const [origine, wsArg, hubUserId = ROBERT] = process.argv.slice(2);
  const env: NodeJS.ProcessEnv = { ...process.env, AUTH_URL: process.env.AUTH_URL ?? 'https://app.veridian.site', CRM_API_URL: process.env.CRM_API_URL ?? 'https://crm.app.veridian.site' };
  if (!origineCrmValide(origine, env)) {
    console.error(`origine refusée (attendu https://<label>.crm.app.veridian.site) : ${origine}`);
    return 2;
  }
  if (!env.MCP_SIGNING_JWK) {
    try {
      env.MCP_SIGNING_JWK = execFileSync('nomad-v', ['raw', 'var', 'get', '-item', 'MCP_SIGNING_JWK', 'nomad/jobs/hub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      console.error('NON ABOUTI : MCP_SIGNING_JWK illisible (nomad-v).');
      return 2;
    }
  }
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const signer = (aud: string, claims: Record<string, unknown>) => signerPourRouteApp({ audience: aud, hubUserId, claims }, env);
  const appeler = async (url: string, jeton: string | null, methode = 'GET', corps?: string) => {
    const r = await fetch(url, {
      method: methode,
      redirect: 'manual',
      headers: { ...(jeton ? { [EN_TETE]: jeton } : {}), ...(corps !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: corps,
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    if (!r) return { statut: 0, corps: 'injoignable' };
    return { statut: r.status, corps: (await r.text()).slice(0, 400) };
  };

  // 0. La route espace : le workspace servi sur cette origine.
  const urlEspace = `${origine}/s/veridian-ia/espace`;
  const espace = await appeler(urlEspace, await signer(urlEspace, { scope: 'ia.espace' }));
  let workspaceId: string | undefined = wsArg;
  let wsServi: string | null = null;
  try {
    wsServi = (JSON.parse(espace.corps) as { workspace_id?: string }).workspace_id ?? null;
  } catch {
    /* route absente ou corps illisible */
  }
  console.log(`espace          GET  ${espace.statut}  ${wsServi ? `workspace_id=${wsServi}` : espace.corps}`);
  workspaceId ??= wsServi ?? undefined;
  if (!workspaceId) {
    console.error('NON ABOUTI : workspace_id inconnu (route espace muette et aucun argument).');
    return 2;
  }

  const session = `epreuve-ver203-${Date.now()}`;
  const url = `${origine}/s/veridian-ia/fils/${session}`;
  const base = { scope: 'ia.fils', tenant_id: 'epreuve', workspace_id: workspaceId, session_id: session };
  const messages = [{ id: 'epreuve-1', role: 'user', parts: [{ type: 'text', text: 'Épreuve VER-203 (Hub), à ignorer.' }] }];
  const corps = JSON.stringify({ messages });

  const res: { nom: string; attendu: (s: number) => boolean; statut: number; corps: string }[] = [];
  const noter = (nom: string, attendu: (s: number) => boolean, r: { statut: number; corps: string }) => res.push({ nom, attendu, ...r });
  const refus = (s: number) => s === 401 || s === 403;

  noter('nominal PUT', (s) => s === 200, await appeler(url, await signer(url, { ...base, corps_sha256: sha(corps) }), 'PUT', corps));
  const jetonGet = (await signer(url, { ...base, corps_sha256: sha('') }))!;
  const lu = await appeler(url, jetonGet);
  const relu = (() => {
    try {
      // Le CRM range le fil en JSON (ordre des clés non garanti) : comparaison en profondeur.
      return isDeepStrictEqual((JSON.parse(lu.corps) as { messages?: unknown }).messages, messages);
    } catch {
      return false;
    }
  })();
  noter(`nominal GET (fil relu : ${relu ? 'identique' : 'DIFFÉRENT'})`, (s) => s === 200 && relu, lu);
  noter('rejeu du même jeton', refus, await appeler(url, jetonGet));
  const autre = `https://pas-${randomUUID().slice(0, 8)}.crm.app.veridian.site/s/veridian-ia/fils/${session}`;
  noter('aud faux (autre sous-domaine)', refus, await appeler(url, await signer(autre, { ...base, corps_sha256: sha('') })));
  noter('workspace_id étranger', refus, await appeler(url, await signer(url, { ...base, workspace_id: randomUUID(), corps_sha256: sha('') })));
  noter('session_id du jeton différent du chemin', refus, await appeler(url, await signer(url, { ...base, session_id: `${session}-x`, corps_sha256: sha('') })));
  const falsifie = JSON.stringify({ messages: [{ ...messages[0], parts: [{ type: 'text', text: 'falsifié' }] }] });
  noter('corps modifié après signature', refus, await appeler(url, await signer(url, { ...base, corps_sha256: sha(corps) }), 'PUT', falsifie));
  noter('scope ia.espace sur la route des fils', refus, await appeler(url, await signer(url, { ...base, scope: 'ia.espace', corps_sha256: sha('') })));
  noter('sans jeton', refus, await appeler(url, null));
  noter('espace avec scope ia.fils', refus, await appeler(urlEspace, await signer(urlEspace, { scope: 'ia.fils' })));

  let ecarts = 0;
  for (const r of res) {
    const ok = r.attendu(r.statut);
    if (!ok) ecarts++;
    console.log(`${ok ? 'OK    ' : 'ÉCART '} ${r.nom.padEnd(44)} ${r.statut}  ${ok && r.statut === 200 ? '' : r.corps}`);
  }
  console.log(`\nfil d'épreuve : ${session} (workspace ${workspaceId}) · ${ecarts ? `${ecarts} ÉCART(S)` : 'tout conforme'}`);
  if (res.some((r) => r.statut === 0)) return 2;
  return ecarts ? 1 : 0;
}

main().then((c) => process.exit(c), () => process.exit(2));

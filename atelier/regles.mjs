// Règles de l'atelier « Mon IA », sans effet de bord (testées par __tests__/atelier/regles.test.ts).
// docs/MON-IA.md, « Où vit l'atelier ».
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

/** Dossier d'un client : dérivé de son hub_user_id, jamais de ce que dit le navigateur ou le modèle. */
export function dossierClient(racine, hubUserId) {
  if (typeof hubUserId !== 'string' || !/^[0-9a-f-]{36}$/i.test(hubUserId)) throw new Error('hub_user_id invalide');
  const nom = createHash('sha256').update(`veridian-atelier:${hubUserId}`).digest('hex').slice(0, 32);
  return path.join(racine, nom);
}

/**
 * Environnement du binaire : construit de zéro, rien n'est hérité de l'atelier (qui n'a de toute façon aucun
 * secret de la flotte). Les connecteurs claude.ai du client et la mémoire automatique sont coupés.
 */
export function environnementBinaire(dossier, extra = {}) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: dossier,
    CLAUDE_CONFIG_DIR: path.join(dossier, 'config'),
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    ...extra,
  };
}

/** Options figées du binaire : aucun outil intégré, aucun réglage lu sur le disque, nos seuls outils. */
export function optionsBinaire(dossier, mcp, { sessionId, reprise, maxTurns = 8 }) {
  return {
    cwd: path.join(dossier, 'travail'),
    env: environnementBinaire(dossier),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { veridian: mcp },
    allowedTools: ['mcp__veridian__chercher_outils', 'mcp__veridian__decrire_outil'],
    maxTurns,
    persistSession: true,
    ...(reprise ? { resume: sessionId } : { sessionId }),
  };
}

// ── Signature Hub ↔ atelier (§6.1 : HMAC sur `${ts}.${corps}`, fenêtre de 5 minutes) ──

export function signer(secret, corps, ts = String(Date.now())) {
  return { ts, sig: createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex') };
}

export function signatureValide(secret, ts, sig, corps, maintenant = Date.now()) {
  if (!secret || !/^\d{10,16}$/.test(String(ts)) || !/^[0-9a-f]{64}$/.test(String(sig))) return false;
  const tsMs = String(ts).length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(maintenant - tsMs) > 5 * 60_000) return false;
  const attendu = Buffer.from(createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex'));
  const recu = Buffer.from(String(sig));
  return attendu.length === recu.length && timingSafeEqual(attendu, recu);
}

/** L'adresse de connexion d'Anthropic, lue dans ce qu'affiche `claude auth login`. Rien d'autre n'en sort. */
export function adresseDeConnexion(sortie) {
  const m = /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com)\/[^\s"']+/.exec(sortie);
  return m ? m[0] : null;
}

/** Le code collé par le client : forme d'un code OAuth, sans retour à la ligne ni espace. */
export function codeValide(code) {
  return typeof code === 'string' && /^[A-Za-z0-9#._~-]{8,512}$/.test(code.trim());
}

// Atelier « Mon IA » (docs/MON-IA.md) : fait tourner le binaire officiel Claude Code pour chaque client, connecté
// avec son propre abonnement. Groupe `atelier` du job Nomad du Hub, même image, autre point d'entrée.
//
// Seul le Hub lui parle (signature HMAC, ATELIER_SECRET). Il n'a aucun secret de la flotte. Le binaire :
//   - n'a aucun outil intégré (`tools: []`) : ni shell, ni fichiers, ni web ;
//   - ne lit aucun réglage sur le disque, ni les connecteurs claude.ai du client ;
//   - n'a que nos trois outils, définis ici et relayés au Hub, qui impose l'espace de la conversation ;
//   - ne joue une écriture qu'après « Autoriser » dans la fenêtre du client.
// La connexion du client est faite par lui, chez Anthropic : nous lançons `claude auth login`, il ouvre l'adresse
// dans son navigateur et recolle le code affiché, tapé tel quel dans le binaire. Nous ne lisons jamais son jeton.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { adresseDeConnexion, codeValide, dossierClient, environnementBinaire, optionsBinaire, signatureValide, signer } from './regles.mjs';

const PORT = Number(process.env.ATELIER_PORT || 3100);
const RACINE = process.env.ATELIER_DONNEES || '/donnees';
const SECRET = process.env.ATELIER_SECRET || '';
const HUB = (process.env.ATELIER_HUB_URL || 'https://app.veridian.site').replace(/\/+$/, '');
const BINAIRE = process.env.ATELIER_BINAIRE || undefined; // sinon, le binaire du SDK
const ATTENTE_APPROBATION_MS = 5 * 60_000;

if (SECRET.length < 32) {
  console.error('[atelier] ATELIER_SECRET absent ou trop court : arrêt');
  process.exit(1);
}

const connexions = new Map(); // hubUserId → { proc, sortie, fin }
const approbations = new Map(); // id → { hubUserId, resolve(bool) }

const journal = (o) => console.log(JSON.stringify({ tag: '[atelier]', ts: new Date().toISOString(), ...o }));

async function preparer(hubUserId) {
  const dossier = dossierClient(RACINE, hubUserId);
  await mkdir(path.join(dossier, 'config'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dossier, 'travail'), { recursive: true, mode: 0o700 });
  return dossier;
}

function lancerBinaire(dossier, args) {
  const exe = BINAIRE || 'claude';
  return spawn(exe, args, { cwd: path.join(dossier, 'travail'), env: environnementBinaire(dossier, { BROWSER: '/bin/false' }), stdio: ['pipe', 'pipe', 'pipe'] });
}

async function appelHub(chemin, corps) {
  const brut = JSON.stringify(corps);
  const { ts, sig } = signer(SECRET, brut);
  const r = await fetch(`${HUB}${chemin}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Atelier-Signature': sig },
    body: brut,
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`hub ${r.status} ${j.error ?? ''}`);
  return j;
}

/** Nos trois outils, relayés au Hub pour (client, tenant, session) ; le modèle ne choisit pas l'espace. */
function serveurOutils(ctx) {
  const relais = (nom) => async (args) => {
    const r = await appelHub('/api/ia/atelier/outil', { ...ctx, nom, arguments: args });
    return { content: [{ type: 'text', text: String(r.texte ?? '') }], ...(r.erreur ? { isError: true } : {}) };
  };
  return createSdkMcpServer({
    name: 'veridian',
    version: '1.0.0',
    tools: [
      tool('chercher_outils', "Trouve les outils des apps Veridian du compte pour un besoin. Rend des noms d'outils <app>.<outil>.", { besoin: z.string(), app: z.string().optional() }, relais('chercher_outils')),
      tool('decrire_outil', "Rend la description et les paramètres d'un outil trouvé par chercher_outils.", { nom: z.string() }, relais('decrire_outil')),
      tool(
        'executer_outil',
        "Exécute un outil d'une app Veridian dans l'espace de cette conversation. Lire d'abord ses paramètres avec decrire_outil.",
        { nom: z.string(), arguments: z.record(z.string(), z.unknown()).optional() },
        relais('executer_outil'),
      ),
    ],
  });
}

// ── Routes ──

async function lireCorps(req) {
  const morceaux = [];
  let taille = 0;
  for await (const m of req) {
    taille += m.length;
    if (taille > 400_000) throw new Error('trop_gros');
    morceaux.push(m);
  }
  return Buffer.concat(morceaux).toString('utf8');
}

const repondre = (res, statut, corps) => {
  res.writeHead(statut, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corps));
};

async function debutConnexion(res, { hubUserId }) {
  const dossier = await preparer(hubUserId);
  connexions.get(hubUserId)?.proc.kill();
  const proc = lancerBinaire(dossier, ['auth', 'login', '--claudeai']);
  const etat = { proc, sortie: '', fin: null };
  connexions.set(hubUserId, etat);
  proc.stdout.on('data', (d) => (etat.sortie += d.toString()));
  proc.stderr.on('data', (d) => (etat.sortie += d.toString()));
  proc.on('exit', (code) => (etat.fin = code));
  setTimeout(() => proc.kill(), 10 * 60_000).unref();
  const debut = Date.now();
  while (!adresseDeConnexion(etat.sortie) && etat.fin === null && Date.now() - debut < 15_000) await new Promise((r) => setTimeout(r, 200));
  const url = adresseDeConnexion(etat.sortie);
  journal({ evt: 'connexion.debut', ok: Boolean(url) });
  return url ? repondre(res, 200, { url }) : repondre(res, 502, { error: 'adresse_introuvable' });
}

async function codeConnexion(res, { hubUserId, code }) {
  const etat = connexions.get(hubUserId);
  if (!etat || etat.fin !== null) return repondre(res, 409, { error: 'connexion_non_commencee' });
  if (!codeValide(code)) return repondre(res, 400, { error: 'code_invalide' });
  etat.proc.stdin.write(`${code.trim()}\n`);
  const debut = Date.now();
  while (etat.fin === null && Date.now() - debut < 30_000) await new Promise((r) => setTimeout(r, 250));
  connexions.delete(hubUserId);
  journal({ evt: 'connexion.code', fin: etat.fin });
  return etat.fin === 0 ? statutConnexion(res, { hubUserId }) : repondre(res, 400, { error: 'connexion_refusee' });
}

async function statutConnexion(res, { hubUserId }) {
  const dossier = await preparer(hubUserId);
  const proc = lancerBinaire(dossier, ['auth', 'status', '--json']);
  let sortie = '';
  proc.stdout.on('data', (d) => (sortie += d.toString()));
  const code = await new Promise((r) => proc.on('exit', r));
  let s = {};
  try {
    s = JSON.parse(sortie);
  } catch {
    s = {};
  }
  // On ne renvoie que ce qu'il faut à l'écran : connecté ou non, l'adresse, le type d'abonnement.
  const connecte = code === 0 && Boolean(s.loggedIn ?? s.authenticated ?? s.email);
  return repondre(res, 200, { connecte, email: connecte ? (s.email ?? s.account?.email ?? null) : null, abonnement: connecte ? (s.subscriptionType ?? s.plan ?? null) : null });
}

async function finConnexion(res, { hubUserId }) {
  const dossier = dossierClient(RACINE, hubUserId);
  const proc = lancerBinaire(dossier, ['auth', 'logout']);
  await new Promise((r) => proc.on('exit', r));
  await rm(dossier, { recursive: true, force: true });
  journal({ evt: 'connexion.fin' });
  return repondre(res, 200, { deconnecte: true });
}

async function tour(res, { hubUserId, tenantId, sessionId, nouvelle, message }) {
  if (typeof message !== 'string' || !message.trim()) return repondre(res, 400, { error: 'message_vide' });
  const dossier = await preparer(hubUserId);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const ecrire = (o) => res.write(`${JSON.stringify(o)}\n`);
  const ctx = { hubUserId, tenantId, sessionId };
  const options = {
    ...optionsBinaire(dossier, serveurOutils(ctx), { sessionId, reprise: !nouvelle }),
    ...(BINAIRE ? { pathToClaudeCodeExecutable: BINAIRE } : {}),
    includePartialMessages: true,
    // Une écriture attend l'humain ; la lecture seule se décide au Hub, d'après la déclaration de l'outil.
    canUseTool: async (nom, input) => {
      if (nom !== 'mcp__veridian__executer_outil') return { behavior: 'deny', message: 'outil non autorisé' };
      const { lectureSeule } = await appelHub('/api/ia/atelier/lecture-seule', { ...ctx, nom: input.nom }).catch(() => ({ lectureSeule: false }));
      if (lectureSeule) return { behavior: 'allow', updatedInput: input };
      const id = randomUUID();
      ecrire({ type: 'approbation', id, outil: input.nom, arguments: input.arguments ?? {} });
      const ok = await new Promise((resolve) => {
        approbations.set(id, { hubUserId, resolve });
        setTimeout(() => resolve(false), ATTENTE_APPROBATION_MS).unref();
      });
      approbations.delete(id);
      return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: "L'utilisateur a refusé." };
    },
  };
  try {
    for await (const m of query({ prompt: message, options })) {
      if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
        ecrire({ type: 'texte', delta: m.event.delta.text });
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) if (b.type === 'tool_use') ecrire({ type: 'outil', nom: b.input?.nom ?? b.name });
      } else if (m.type === 'result') {
        ecrire({ type: 'fin', etat: m.subtype, jetons: (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0) });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = /log ?in|auth|credential|401/i.test(msg) ? 'non_connecte' : 'erreur_binaire';
    journal({ evt: 'tour.erreur', code });
    ecrire({ type: 'erreur', code });
  }
  res.end();
}

const ROUTES = {
  '/connexion/debut': debutConnexion,
  '/connexion/code': codeConnexion,
  '/connexion/statut': statutConnexion,
  '/connexion/fin': finConnexion,
  '/tour': tour,
  // Une approbation ne vaut que pour le client à qui elle a été demandée.
  '/approbation': async (res, { hubUserId, id, ok }) => {
    const a = approbations.get(id);
    if (!a || a.hubUserId !== hubUserId) return repondre(res, 404, { error: 'approbation_inconnue' });
    a.resolve(ok === true);
    return repondre(res, 200, { ok: true });
  },
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/sante') return repondre(res, 200, { status: 'ok' });
      const route = ROUTES[req.url ?? ''];
      if (req.method !== 'POST' || !route) return repondre(res, 404, { error: 'inconnu' });
      const brut = await lireCorps(req);
      if (!signatureValide(SECRET, req.headers['x-veridian-timestamp'], req.headers['x-veridian-atelier-signature'], brut)) {
        return repondre(res, 401, { error: 'signature' });
      }
      const corps = JSON.parse(brut);
      dossierClient(RACINE, corps.hubUserId); // refuse un hub_user_id mal formé avant tout
      return await route(res, corps);
    } catch (err) {
      journal({ evt: 'requete.erreur', erreur: err instanceof Error ? err.name : 'erreur' });
      if (!res.headersSent) repondre(res, 400, { error: 'requete_invalide' });
      else res.end();
    }
  })
  .listen(PORT, () => journal({ evt: 'pret', port: PORT }));

/**
 * Coffre des clés d'IA (ROB-188, « Mon IA », docs/MON-IA.md).
 *
 * Une clé de fournisseur (Anthropic, OpenAI, Mistral, OpenRouter) est chiffrée au repos en AES-256-GCM.
 * La clé de chiffrement est dérivée de `VAULT_ENC_KEY` (Nomad Variable `nomad/jobs/hub`) par HKDF-SHA256,
 * avec un contexte propre à ce coffre : changer d'usage de `VAULT_ENC_KEY` ne rend jamais une clé lisible
 * par un autre code. IV aléatoire de 12 octets par chiffrement, étiquette GCM vérifiée au déchiffrement.
 *
 * Une clé en clair ne quitte jamais la mémoire du serveur le temps d'un appel : jamais renvoyée au
 * navigateur, jamais journalisée. `masquer` retire toute clé connue d'un texte (erreur du fournisseur,
 * trace du SDK) avant qu'il parte dans un journal ou une réponse.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const CONTEXTE = 'veridian-hub/mon-ia/cles/v1';

export class CoffreIndisponible extends Error {
  constructor() {
    super('coffre_indisponible : VAULT_ENC_KEY absente');
    this.name = 'CoffreIndisponible';
  }
}

function cleDeChiffrement(env: NodeJS.ProcessEnv = process.env): Buffer {
  const maitre = env.VAULT_ENC_KEY?.trim();
  if (!maitre || maitre.length < 32) throw new CoffreIndisponible();
  return Buffer.from(hkdfSync('sha256', maitre, Buffer.alloc(0), CONTEXTE, 32));
}

/** `v1.<iv>.<etiquette>.<chiffre>`, chaque partie en base64url. */
export function chiffrer(clair: string, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cleDeChiffrement(env), iv);
  const chiffre = Buffer.concat([c.update(clair, 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), chiffre.toString('base64url')].join('.');
}

export function dechiffrer(scelle: string, env?: NodeJS.ProcessEnv): string {
  const [version, iv, etiquette, chiffre] = scelle.split('.');
  if (version !== VERSION || !iv || !etiquette || chiffre === undefined) throw new Error('coffre : format inconnu');
  const d = createDecipheriv('aes-256-gcm', cleDeChiffrement(env), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(etiquette, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(chiffre, 'base64url')), d.final()]).toString('utf8');
}

/** Pour reconnaître une clé (doublon, révocation) sans la garder en clair. */
export function empreinteCle(clair: string): string {
  return createHash('sha256').update(`${CONTEXTE}:${clair}`).digest('hex');
}

/** Ce qui peut s'afficher d'une clé : ses 4 derniers caractères. */
export function finDeCle(clair: string): string {
  return clair.length > 8 ? clair.slice(-4) : '';
}

/**
 * Retire de `texte` toute clé de `cles`, et toute forme de clé de fournisseur reconnaissable
 * (`sk-…`, `sk-ant-…`, `sk-or-…`), même inconnue : une erreur du fournisseur peut citer la clé
 * reçue, une trace du SDK peut recopier les en-têtes.
 */
export function masquer(texte: string, cles: readonly string[] = []): string {
  let s = texte;
  for (const c of cles) if (c && c.length >= 8) s = s.split(c).join('[clé masquée]');
  return s
    .replace(/\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}/g, '[clé masquée]')
    .replace(/(authorization|x-api-key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]{8,}/gi, '$1$2[clé masquée]');
}

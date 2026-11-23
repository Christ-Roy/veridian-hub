/**
 * Plafond d'essais de mot de passe PAR COMPTE, quelle que soit l'adresse d'où ils viennent (23/11). Partagé par les
 * deux seules portes qui vérifient un mot de passe : `mfa/start` et `authorize` (auth.ts).
 *
 * Il ralentit sans laisser un tiers fermer la porte d'un client :
 *   - seuls les ÉCHECS comptent (une place est prise avant la vérification, rendue si elle réussit), et un essai refusé
 *     ne prolonge rien : la porte rouvre seule, au plus FENETRE_MS après le dernier échec compté ;
 *   - un navigateur qui a déjà réussi à entrer dans CE compte (cookie signé) a son propre couloir ;
 *   - Google, Microsoft et le lien de réinitialisation (qui pose aussi ce cookie) ne passent pas par ici.
 * Une adresse sans compte est plafonnée pareil : la réponse ne dit pas si le compte existe.
 * En mémoire, comme les autres limiteurs (une instance ; un déploiement le remet à zéro).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { normaliserEmail } from '@/lib/auth/email-normalize';
import { secureCookiesEnabled } from '@/lib/auth/impersonation';
import { shouldBypassRateLimit } from '@/lib/auth/rate-limit';

export const ECHECS_MAX = 10;
export const FENETRE_MS = 15 * 60_000;
const BALAYAGE_TOUS_LES = 256;

export class PlafondEchecs {
  private echecs = new Map<string, number[]>();
  private operations = 0;

  constructor(
    private readonly max: number = ECHECS_MAX,
    private readonly fenetreMs: number = FENETRE_MS,
  ) {}

  /** Prend une place avant la vérification (des essais simultanés ne passent pas tous). */
  reserver(cle: string, maintenant = Date.now()): { ok: true; rendre: () => void } | { ok: false; retryAfterSeconds: number } {
    const debut = maintenant - this.fenetreMs;
    if (++this.operations >= BALAYAGE_TOUS_LES) {
      this.operations = 0;
      for (const [k, v] of Array.from(this.echecs)) if (v[v.length - 1] <= debut) this.echecs.delete(k);
    }
    const frais = (this.echecs.get(cle) ?? []).filter((t) => t > debut);
    if (frais.length >= this.max) {
      this.echecs.set(cle, frais);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((frais[0] + this.fenetreMs - maintenant) / 1000)) };
    }
    frais.push(maintenant);
    this.echecs.set(cle, frais);
    return {
      ok: true,
      rendre: () => {
        const l = this.echecs.get(cle);
        const i = l ? l.indexOf(maintenant) : -1;
        if (!l || i < 0) return;
        l.splice(i, 1);
        if (l.length === 0) this.echecs.delete(cle);
      },
    };
  }

  reset() {
    this.echecs.clear();
  }

  size() {
    return this.echecs.size;
  }
}

export const plafondCompte = new PlafondEchecs();

// ── Navigateur déjà entré dans ce compte ──────────────────────────────────────

const APPAREIL_TTL_S = 180 * 24 * 3600;
export const nomCookieAppareil = (secure = secureCookiesEnabled()): string => (secure ? '__Host-veridian-appareil' : 'veridian-appareil');

const empreinte = (email: string): string => createHash('sha256').update(`compte|${normaliserEmail(email)}`).digest('base64url').slice(0, 22);
const signature = (corps: string, secret: string): string => createHmac('sha256', secret).update(`appareil|${corps}`).digest('base64url');

export function signerAppareil(email: string, secret: string, maintenantS = Math.floor(Date.now() / 1000)): string {
  const corps = `${empreinte(email)}.${randomBytes(9).toString('base64url')}.${maintenantS + APPAREIL_TTL_S}`;
  return `${corps}.${signature(corps, secret)}`;
}

/** L'identifiant de l'appareil si le cookie est authentique, non expiré, et pour CE compte ; sinon null. */
export function lireAppareil(cookies: string | null, email: string, secret: string, maintenantS = Math.floor(Date.now() / 1000)): string | null {
  const nom = nomCookieAppareil();
  const valeur = (cookies ?? '').split(';').map((m) => m.trim()).find((m) => m.startsWith(`${nom}=`))?.slice(nom.length + 1);
  const morceaux = valeur?.split('.') ?? [];
  if (morceaux.length !== 4) return null;
  const [compte, id, exp, sig] = morceaux;
  const attendue = Buffer.from(signature(`${compte}.${id}.${exp}`, secret));
  const recue = Buffer.from(sig);
  if (attendue.length !== recue.length || !timingSafeEqual(attendue, recue)) return null;
  if (compte !== empreinte(email) || !(Number(exp) > maintenantS)) return null;
  return id;
}

type AvecCookies = { cookies: { set: (nom: string, valeur: string, o: { httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number }) => unknown } };

/** À poser après une entrée réussie (mot de passe seul, code MFA, réinitialisation). Sans secret : rien. */
export function poserAppareil(res: AvecCookies, email: string): void {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return;
  const secure = secureCookiesEnabled();
  res.cookies.set(nomCookieAppareil(secure), signerAppareil(email, secret), { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: APPAREIL_TTL_S });
}

// ── Vérification ─────────────────────────────────────────────────────────────

export type VerdictMotDePasse = { etat: 'ok' } | { etat: 'refuse' } | { etat: 'ralenti'; retryAfterSeconds: number };

/** Vérifie un mot de passe sous le plafond du compte. `hash` null : compte absent ou sans mot de passe (refusé, compté). */
export async function verifierMotDePasse(
  p: { email: string; password: string; headers: Headers; lireHash: () => Promise<string | null> },
  plafond: PlafondEchecs = plafondCompte,
): Promise<VerdictMotDePasse> {
  const secret = process.env.AUTH_SECRET ?? '';
  const appareil = secret ? lireAppareil(p.headers.get('cookie'), p.email, secret) : null;
  const compte = empreinte(p.email);
  const place = shouldBypassRateLimit(p.headers)
    ? { ok: true as const, rendre: () => undefined }
    : plafond.reserver(appareil ? `appareil:${compte}:${appareil}` : `compte:${compte}`);
  if (!place.ok) {
    console.warn(JSON.stringify({ tag: '[auth-compte-ralenti]', level: 'warn', compte, appareil: Boolean(appareil), retry_after_s: place.retryAfterSeconds, ts: new Date().toISOString() }));
    return { etat: 'ralenti', retryAfterSeconds: place.retryAfterSeconds };
  }
  const hash = await p.lireHash();
  if (!hash || !(await bcrypt.compare(p.password, hash))) return { etat: 'refuse' };
  place.rendre();
  return { etat: 'ok' };
}

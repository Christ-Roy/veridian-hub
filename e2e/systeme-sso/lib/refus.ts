/**
 * Un rebond refusé s'explique (08/11 : Robert renvoyé sans un mot). La condition est pure, pour que
 * le contrôle d'échec la voie tomber sur le retour muet d'avant (`/dashboard?hint=signup`).
 */
import { HUB_URL, masquer } from './cibles';
import type { Atterrissage } from './parcours';

const EXPLICATION: Record<string, RegExp> = {
  user_not_in_app: /pas encore d.accès/i,
  hub_user_conflict: /rattaché à un autre/i,
};

export function devraitExpliquerLeRefus(a: Atterrissage, code: 'user_not_in_app' | 'hub_user_conflict', email: string) {
  const fin = `${a.hote}${a.chemin}`;
  const u = new URL(a.url);
  const ok = (c: boolean, m: string) => {
    if (!c) throw new Error(masquer(`refus muet ou flou (${fin}) : ${m}. Texte : « ${a.texte.slice(0, 160).replace(/\s+/g, ' ')} »`));
  };
  ok(a.hote === new URL(HUB_URL).host && a.chemin === '/auth/bounce/error', 'pas sur la page qui explique le refus');
  ok(u.searchParams.get('code') === code, `code ${u.searchParams.get('code')} au lieu de ${code}`);
  ok(EXPLICATION[code].test(a.texte), 'la cause n\'est pas dite');
  ok(a.texte.toLowerCase().includes(email.toLowerCase()), `l'adresse de la session (${email}) n'est pas nommée`);
}

/**
 * Lit les VRAIS mails des comptes de test. `e2e-sso-preuve@` et `e2e-sso-essai@veridian.site` sont des
 * groupes Lark (créés le 08/11, Robert membre) : le mail arrive dans la boîte Lark de Robert, que le CLI
 * `mail` lit. Le jeton de preuve n'est stocké que haché au Hub : seul le mail le porte.
 */
import { execFileSync } from 'node:child_process';

import { NonAbouti } from './etat';

export const ADRESSE_PREUVE = 'e2e-sso-preuve@veridian.site';
const OBJET = 'Confirmez votre adresse';
const LIEN = /https:\/\/[^\s"'<>]+\/auth\/email-proof\?token=[A-Za-z0-9_%.\-]+/;

const mailCli = (args: string[]) =>
  execFileSync('mail', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

/** Attend le mail de preuve adressé à `adresse` après `depuis`, et rend son lien. */
export async function lienDePreuve(adresse: string, depuis: Date, ms = 180_000): Promise<string> {
  const texte = await attendreMail(adresse, OBJET, depuis, ms, (t) => LIEN.test(t));
  return texte.match(LIEN)![0];
}

/** Attend un mail adressé à `adresse` après `depuis`, dont l'objet contient `objet`, et rend son texte. */
export async function attendreMail(
  adresse: string,
  objet: string,
  depuis: Date,
  ms = 180_000,
  accepte: (texte: string) => boolean = () => true,
): Promise<string> {
  const fin = Date.now() + ms;
  const vus = new Set<string>();
  while (Date.now() < fin) {
    let liste = '';
    try {
      liste = mailCli(['list', '--account', 'lark', '--folder', 'inbox', '--limit', '20']);
    } catch (e) {
      throw new NonAbouti(`boîte Lark illisible (mail list) : ${(e as Error).message.split('\n')[0]}`);
    }
    for (const ligne of liste.split('\n')) {
      const m = ligne.match(/\[\s*(\d+)\]/);
      if (!m || vus.has(m[1]) || !ligne.includes(objet)) continue;
      vus.add(m[1]);
      const texte = mailCli(['read', '--account', 'lark', '--uid', m[1]]);
      const to = texte.match(/^To\s*:\s*(.*)$/m)?.[1] ?? '';
      const date = new Date(texte.match(/^Date\s*:\s*(.*)$/m)?.[1] ?? 0);
      if (to.toLowerCase().includes(adresse) && date.getTime() >= depuis.getTime() - 60_000 && accepte(texte)) return texte;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new NonAbouti(`aucun mail « ${objet} » pour ${adresse} en ${ms / 1000} s (Brevo, ou boîte Lark)`);
}

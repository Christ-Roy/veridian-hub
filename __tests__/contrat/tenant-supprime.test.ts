/**
 * Contrat : un tenant supprimé (`deletedAt` posé) n'est jamais repris par une recherche « le tenant de
 * cet utilisateur ». Trois fois le 08 et 09/11 : un signal d'essai inscrit sur un tenant supprimé, le
 * provisionnement qui reprenait un tenant supprimé, et `link-app` qui a rattaché deux comptes réels à
 * leurs anciens tenants supprimés (l'un portait encore un espace Notifuse).
 *
 * Toute recherche `tenant.findFirst/findMany/findUnique` filtrée par `userId` doit porter `deletedAt`,
 * ou figurer ci-dessous avec sa raison (vues d'admin et de suppression qui DOIVENT voir les supprimés).
 */
import { describe, expect, it } from 'vitest';

import { code, parcourir } from './source';

const VOIENT_LES_SUPPRIMES: Record<string, string> = {
  'app/api/admin/delete-tenant/route.ts': 'suppression : marque aussi les tenants déjà supprimés du compte',
  'app/api/admin/users-lookup/route.ts': 'vue admin : montre l\'historique complet',
  'app/api/admin/users/[email]/route.ts': 'vue admin : montre l\'historique complet',
  'lib/admin/find-orphan-users.ts': 'audit des comptes sans tenant : un tenant supprimé compte',
};

/** Chaque appel `tenant.findX({ … })` et son objet d'arguments (accolades équilibrées). */
function recherches(src: string): string[] {
  const out: string[] = [];
  const re = /\btenant\.find(First|Many|Unique|FirstOrThrow)\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let prof = 1;
    while (i < src.length && prof > 0) {
      if (src[i] === '{') prof++;
      else if (src[i] === '}') prof--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** L'objet `where: { … }` d'un appel (accolades équilibrées), ou '' s'il n'y en a pas. */
function clauseWhere(appel: string): string {
  const d = appel.search(/\bwhere\s*:\s*\{/);
  if (d < 0) return '';
  let i = appel.indexOf('{', d) + 1;
  let prof = 1;
  while (i < appel.length && prof > 0) {
    if (appel[i] === '{') prof++;
    else if (appel[i] === '}') prof--;
    i++;
  }
  return appel.slice(d, i);
}

const fichiers = [...parcourir('app'), ...parcourir('lib'), ...parcourir('utils')].filter((p) => /\.(ts|tsx)$/.test(p));

describe('tenants supprimés', () => {
  it('aucune recherche du tenant d\'un utilisateur ne reprend un tenant supprimé', () => {
    const fautifs: string[] = [];
    for (const f of fichiers) {
      if (VOIENT_LES_SUPPRIMES[f]) continue;
      for (const r of recherches(code(f))) {
        const where = clauseWhere(r);
        if (/\buserId\b/.test(where) && !/\bdeletedAt\b/.test(where)) fautifs.push(`${f} : ${r.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(fautifs).toEqual([]);
  });

  it('chaque exception existe encore', () => {
    for (const f of Object.keys(VOIENT_LES_SUPPRIMES)) expect(fichiers, f).toContain(f);
  });
});

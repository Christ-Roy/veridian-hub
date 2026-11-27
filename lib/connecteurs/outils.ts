/**
 * Les outils servis d'un service extérieur : une liste figée dans le registre, chacun avec l'empreinte de sa définition relue. Ce que le service annonce de lui
 * (`readOnlyHint`) n'est pas une preuve : la lecture et l'écriture se décident ici. Un outil inconnu, ou dont un mot a changé, n'est pas servi : il est relevé
 * pour relecture.
 */
import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { OutilApp } from '@/lib/mcp/client-app';

import { outilRelu, type Connecteur } from './registre';
import { montrer } from './texte';

const VUS_MAX = 300;
const DEFINITION_MAX_CAR = 20_000;

/** La même définition, quel que soit l'ordre de ses champs. */
function stable(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stable);
  if (x === null || typeof x !== 'object') return x;
  // Des paires, pas un objet : une clé `__proto__` disparaîtrait d'un objet, et avec elle ce qu'elle porte.
  return { o: Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, stable(v)]) };
}
/** L'outil ENTIER : un champ que nous ne lisons pas aujourd'hui (`outputSchema`, `_meta`…) compte aussi. */
export const empreinteOutil = (o: OutilApp): string => createHash('sha256').update(JSON.stringify(stable(o))).digest('hex');

export type Tri = { servis: OutilApp[]; aRelire: { outil: OutilApp; empreinte: string }[] };

/** Les outils servis, avec NOS annonces. `ecriture` : la personne l'a allumée pour ce service. Deux outils du même nom : aucun des deux. */
export function trier(c: Connecteur, annonces: OutilApp[], ecriture: boolean): Tri {
  const t: Tri = { servis: [], aRelire: [] };
  const l = annonces.filter((o) => o !== null && typeof o === 'object' && typeof o.name === 'string');
  for (const o of l) {
    const relu = outilRelu(c, o.name);
    const empreinte = empreinteOutil(o);
    if (!relu || relu.empreinte !== empreinte || l.filter((x) => x.name === o.name).length > 1) {
      t.aRelire.push({ outil: o, empreinte });
      continue;
    }
    if (relu.acces === 'ecriture' && !ecriture) continue;
    const lit = relu.acces === 'lecture';
    t.servis.push({ ...o, annotations: { readOnlyHint: lit, destructiveHint: !lit, openWorldHint: true } });
  }
  return t;
}

/** Entière ou rien : une définition coupée se relirait à moitié, alors que son empreinte la couvre toute. */
function entiere(o: OutilApp): string {
  const t = montrer(JSON.stringify(o));
  return t.length <= DEFINITION_MAX_CAR ? t : `TROP LONGUE (${t.length} caractères), ne pas inscrire au registre`;
}

/** Relève, une fois par définition, ce qui attend une relecture. Au mieux : un relevé raté n'empêche rien d'autre, il ne sert jamais un outil. */
export async function relever(db: Pick<PrismaClient, 'connecteurOutilVu'>, c: Connecteur, l: Tri['aRelire']): Promise<void> {
  if (l.length === 0) return;
  const deja = new Set((await db.connecteurOutilVu.findMany({ where: { connecteur: c.cle }, select: { empreinte: true } })).map((x) => x.empreinte));
  const neufs = l.filter((x) => !deja.has(x.empreinte)).slice(0, Math.max(0, VUS_MAX - deja.size));
  if (neufs.length === 0) return;
  console.warn(JSON.stringify({ tag: '[connecteur]', level: 'warn', msg: 'outils à relire', connecteur: c.cle, nombre: neufs.length }));
  await db.connecteurOutilVu.createMany({
    data: neufs.map((x) => ({ connecteur: c.cle, empreinte: x.empreinte, nom: montrer(x.outil.name).slice(0, 200), definition: entiere(x.outil) })),
    skipDuplicates: true,
  });
}

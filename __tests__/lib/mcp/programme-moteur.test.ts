// @vitest-environment node
/** Le Hub vers la passerelle : l'élévation HTTP, le découpage en lignes, et ce que le Hub refuse de garder en mémoire. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mcp/identite', () => ({ signerPourProgramme: async (p: string) => `jeton-${p}` }));

import { enMoteur, ouvrirMoteur, programmeConfigure } from '@/lib/mcp/programme-moteur';

const tour = () => new Promise((r) => setTimeout(r, 20));
function moteur(max = 100) {
  const entree = new PassThrough();
  const sortie = new PassThrough();
  const m = enMoteur(Duplex.from({ readable: entree, writable: sortie }), max);
  const lignes: string[] = [];
  const fin = vi.fn();
  m.surLigne((l) => lignes.push(l));
  m.surFin(fin);
  return { m, entree, sortie, lignes, fin };
}

describe('enMoteur', () => {
  it('une ligne coupée en morceaux, plusieurs lignes d\'un coup, un accent à cheval sur deux morceaux', async () => {
    const t = moteur();
    const e = Buffer.from('é');
    t.entree.write('{"a":');
    t.entree.write('1}\n{"b":2}\nx');
    t.entree.write(e.subarray(0, 1));
    t.entree.write(Buffer.concat([e.subarray(1), Buffer.from('\n')]));
    await tour();
    expect(t.lignes).toEqual(['{"a":1}', '{"b":2}', 'xé']);
    expect(t.fin).not.toHaveBeenCalled();
  });

  it('une ligne sans fin est coupée : le moteur est fermé, rien d\'autre n\'est lu', async () => {
    const t = moteur(100);
    t.entree.write('x'.repeat(101));
    await tour();
    expect(t.fin).toHaveBeenCalledTimes(1);
    t.entree.write('\n{"a":1}\n');
    await tour();
    expect(t.lignes).toEqual([]);
  });

  it('un exécuteur qui ne lit pas ne remplit pas la mémoire du Hub', async () => {
    const t = moteur();
    for (let i = 0; i < 20 && t.fin.mock.calls.length === 0; i++) t.m.envoyer({ v: 'x'.repeat(1_000_000) });
    expect(t.fin).toHaveBeenCalledTimes(1);
  });

  it('fermé une fois : la fin n\'est dite qu\'une fois, envoyer ne lève pas', async () => {
    const t = moteur();
    t.m.fermer();
    t.m.fermer();
    t.m.envoyer({ t: 'x' });
    await tour();
    expect(t.fin).toHaveBeenCalledTimes(1);
  });
});

describe('ouvrirMoteur', () => {
  let serveur: http.Server;
  let recu: http.IncomingHttpHeaders[];
  const avant = process.env.PROGRAMME_FICHIER;
  const declarer = (...l: string[]) => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'moteur-')), 'programme');
    writeFileSync(f, l.map((x) => `${x}\n`).join(''));
    process.env.PROGRAMME_FICHIER = f;
  };
  const adresse = () => `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;

  beforeEach(async () => {
    recu = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    serveur = http.createServer((_q, r) => r.writeHead(503).end());
    serveur.on('upgrade', (q, s) => {
      recu.push(q.headers);
      s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: programme\r\n\r\n{"t":"tete"}\n');
      s.on('data', (d) => s.write(d));
      s.on('error', () => undefined);
    });
    await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  });
  afterEach(() => {
    serveur.close();
    serveur.closeAllConnections();
    if (avant === undefined) delete process.env.PROGRAMME_FICHIER;
    else process.env.PROGRAMME_FICHIER = avant;
  });

  it('s\'élève avec le jeton du Hub, ne perd pas ce qui suit l\'en-tête, et parle dans les deux sens', async () => {
    declarer(adresse());
    const m = (await ouvrirMoteur('p-7', 1_000))!;
    const lignes: string[] = [];
    m.surLigne((l) => lignes.push(l));
    m.envoyer({ t: 'programme' });
    await vi.waitFor(() => expect(lignes).toEqual(['{"t":"tete"}', '{"t":"programme"}']));
    expect(recu[0]).toMatchObject({ upgrade: 'programme', authorization: 'Bearer jeton-p-7' });
    m.fermer();
  });

  it('une adresse morte n\'empêche pas la suivante ; une passerelle qui refuse rend null, jamais une exception', async () => {
    declarer('http://127.0.0.1:1', adresse());
    const m = await ouvrirMoteur('p', 1_000);
    expect(m).not.toBeNull();
    m!.fermer();
    serveur.removeAllListeners('upgrade');
    declarer(adresse());
    expect(await ouvrirMoteur('p', 1_000)).toBeNull();
  });

  it('configuré seulement si le job le dit ; fichier vide ou absent : null', async () => {
    expect(programmeConfigure({ NODE_ENV: 'test' })).toBe(false);
    expect(programmeConfigure({ NODE_ENV: 'test', PROGRAMME_FICHIER: '/x' })).toBe(true);
    declarer();
    expect(await ouvrirMoteur('p', 1_000)).toBeNull();
    process.env.PROGRAMME_FICHIER = '/n/existe/pas';
    expect(await ouvrirMoteur('p', 1_000)).toBeNull();
  });
});

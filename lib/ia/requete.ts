/**
 * Les routes « Mon IA » ne répondent qu'à la fenêtre du Hub lui-même. Un espace d'une autre app (même site
 * `veridian.site`, donc avec le cookie du Hub) ne doit pas pouvoir poser une question, allumer un interrupteur ou
 * brancher une clé au nom de l'utilisateur. Un navigateur envoie toujours `Sec-Fetch-Site` (ou `Origin` sur un POST) :
 * on refuse tout ce qui n'est pas de même origine. Un client sans navigateur n'a pas de cookie volé à rejouer.
 */
import { NextResponse } from 'next/server';

import { hubIssuer } from '@/lib/mcp/config';

/** `req` : une NextRequest (seuls ses en-têtes et son origine servent). */
export function refusSiCroisee(req: { headers: Headers; nextUrl: { origin: string } }, env: NodeJS.ProcessEnv = process.env): NextResponse | null {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return NextResponse.json({ error: 'origine_refusee' }, { status: 403 });
  const origine = req.headers.get('origin');
  if (origine) {
    const permises = new Set([req.nextUrl.origin]);
    try {
      permises.add(new URL(hubIssuer(env)).origin);
    } catch {
      /* AUTH_URL illisible : seule l'origine de la requête compte */
    }
    if (!permises.has(origine)) return NextResponse.json({ error: 'origine_refusee' }, { status: 403 });
  }
  return null;
}

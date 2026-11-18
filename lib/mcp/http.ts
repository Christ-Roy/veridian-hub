import { NextResponse, type NextRequest } from 'next/server';

import { CORS } from './config';
import { OauthErreur } from './oauth';

/** Corps d'une requête OAuth : formulaire (norme) ou JSON (certains clients). */
export async function lireParams(request: NextRequest): Promise<Record<string, string | undefined>> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const j = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
  }
  const f = await request.formData().catch(() => null);
  const out: Record<string, string | undefined> = {};
  f?.forEach((v, k) => {
    if (typeof v === 'string') out[k] = v;
  });
  return out;
}

export function reponseErreur(err: unknown) {
  if (err instanceof OauthErreur) {
    return NextResponse.json(err.corps(), { status: err.status, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }
  console.error('[oauth] erreur interne', err);
  return NextResponse.json({ error: 'server_error' }, { status: 500, headers: CORS });
}

export function preflight() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

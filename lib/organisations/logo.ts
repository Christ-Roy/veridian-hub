/** Le logo d'une organisation : décodé puis RÉENCODÉ par le Hub (PNG, métadonnées perdues). SVG refusé : il porte du code. */
import { createHash } from 'node:crypto';

import sharp from 'sharp';

export const LOGO_MAX_OCTETS = 2_000_000;
const COTE = 512;

export async function reencoderLogo(recu: Buffer): Promise<{ png: Buffer; empreinte: string } | { refus: 'trop_gros' | 'format_refuse' }> {
  if (recu.length === 0 || recu.length > LOGO_MAX_OCTETS) return { refus: recu.length ? 'trop_gros' : 'format_refuse' };
  try {
    const image = sharp(recu, { limitInputPixels: 25_000_000, pages: 1 });
    const { format } = await image.metadata();
    if (!format || !['png', 'jpeg', 'webp'].includes(format)) return { refus: 'format_refuse' };
    const png = await image.rotate().resize(COTE, COTE, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    return { png, empreinte: createHash('sha256').update(png).digest('hex').slice(0, 16) };
  } catch {
    return { refus: 'format_refuse' };
  }
}

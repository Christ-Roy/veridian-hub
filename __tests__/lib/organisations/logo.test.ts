// @vitest-environment node
import sharp from 'sharp';
import { expect, it } from 'vitest';

import { LOGO_MAX_OCTETS, reencoderLogo } from '@/lib/organisations/logo';

const image = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#0B5FFF' } });

it('réencode en PNG de 512 px au plus, métadonnées perdues, empreinte stable', async () => {
  const jpeg = await image(2000, 1000).withExif({ IFD0: { Copyright: 'SECRET-EXIF' } }).jpeg().toBuffer();
  const r = await reencoderLogo(jpeg);
  if ('refus' in r) throw new Error(r.refus);
  expect(await sharp(r.png).metadata()).toMatchObject({ format: 'png', width: 512, height: 256 });
  expect(r.png.includes('SECRET-EXIF')).toBe(false);
  expect((await reencoderLogo(jpeg)) as { empreinte: string }).toMatchObject({ empreinte: r.empreinte });
});
it('SVG, GIF, texte, vide, trop gros : refusés', async () => {
  for (const b of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><script>alert(1)</script></svg>'), await image(4, 4).gif().toBuffer(), Buffer.from('bonjour'), Buffer.alloc(0)]) expect(await reencoderLogo(b)).toEqual({ refus: 'format_refuse' });
  expect(await reencoderLogo(Buffer.alloc(LOGO_MAX_OCTETS + 1))).toEqual({ refus: 'trop_gros' });
});

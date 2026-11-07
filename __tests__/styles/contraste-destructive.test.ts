/**
 * Pixel : le texte d'erreur (--destructive) doit rester lisible en sombre comme en clair
 * (4,5:1 minimum, WCAG AA), sur les fonds réels : dégradé des pages auth, carte, voile rouge 10 %.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'styles/main.css'), 'utf8');

function bloc(selecteur: RegExp): string {
  const debut = css.search(selecteur);
  expect(debut).toBeGreaterThan(-1);
  const fin = css.indexOf('\n  }', debut);
  return css.slice(debut, fin);
}
function jeton(b: string, nom: string): [number, number, number] {
  const m = b.match(new RegExp(`--${nom}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`));
  expect(m, `jeton ${nom}`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}
function rgb([L, C, h]: [number, number, number]): number[] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => Math.min(1, Math.max(0, x)));
}
const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function contraste(a: number[], b: number[]) {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const voile = (fg: number[], fond: number[], t: number) => fg.map((v, i) => v * t + fond[i] * (1 - t));

describe('contraste du texte d’erreur', () => {
  it('sombre : --destructive >= 4,5:1 sur le dégradé auth, la carte et le voile rouge 10 %', () => {
    const b = bloc(/^\s*\.dark\s*\{/m);
    const fg = rgb(jeton(b, 'destructive'));
    const fonds: Record<string, [number, number, number]> = {
      degrade1: [0.26, 0.09, 280],
      degrade2: [0.24, 0.11, 310],
      degrade3: [0.26, 0.1, 350],
      carte: jeton(b, 'card'),
      fond: jeton(b, 'background'),
    };
    for (const [nom, f] of Object.entries(fonds)) {
      const fond = rgb(f);
      expect(contraste(fg, fond), nom).toBeGreaterThanOrEqual(4.5);
      expect(contraste(fg, voile(fg, fond, 0.1)), `${nom} + voile`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('sombre : le texte du bouton destructive reste lisible sur son fond', () => {
    const b = bloc(/^\s*\.dark\s*\{/m);
    expect(contraste(rgb(jeton(b, 'destructive-foreground')), rgb(jeton(b, 'destructive')))).toBeGreaterThanOrEqual(4.5);
  });

  it('clair : --destructive >= 4,5:1 sur le fond de page', () => {
    const b = bloc(/^\s*:root\s*\{/m);
    const fg = rgb(jeton(b, 'destructive'));
    const fond = rgb(jeton(b, 'background'));
    expect(contraste(fg, voile(fg, fond, 0.1))).toBeGreaterThanOrEqual(4.5);
  });
});

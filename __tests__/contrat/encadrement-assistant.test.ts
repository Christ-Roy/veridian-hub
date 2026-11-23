/**
 * La fenêtre de l'Assistant Veridian s'affiche dans les apps, et seulement elles ; tout le reste du Hub
 * refuse toute iframe étrangère (docs/MON-IA.md, menace « exfiltration » : une page hostile ferait cliquer
 * « Autoriser »).
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('../../next.config.js');

type Regle = { source: string; headers: { key: string; value: string }[] };

describe('encadrement du Hub', () => {
  it('/ia/chat : seuls les hôtes des apps, jamais un site client <nom>.veridian.site', async () => {
    const regles: Regle[] = await config.headers();
    const chat = regles.find((r) => r.source === '/ia/chat');
    const csp = chat?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).toContain('https://*.app.veridian.site');
    expect(csp).not.toMatch(/https:\/\/\*\.veridian\.site(\s|$)/);
    expect(csp).not.toMatch(/frame-ancestors[^;]*\*(\s|;|$)/);
    expect(chat?.headers.some((h) => h.key === 'X-Frame-Options')).toBe(false);
  });

  it('/ia/chat : plus aucun espace du CRM (chat natif depuis le 23/11, le plugin n\'encadre plus la fenêtre)', async () => {
    const regles: Regle[] = await config.headers();
    const csp = regles.find((r) => r.source === '/ia/chat')?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).not.toContain('crm.app.veridian.site');
  });

  it('tout le reste garde SAMEORIGIN et frame-ancestors self, /ia/chat exclu de cette règle seulement', async () => {
    const regles: Regle[] = await config.headers();
    const generale = regles.find((r) => r.headers.some((h) => h.key === 'X-Frame-Options'));
    expect(generale?.headers).toEqual(expect.arrayContaining([{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }]));
    const motif = new RegExp(`^${generale!.source.replace('/((?!ia/chat).*)', '/((?!ia/chat).*)').replace(/^\//, '\\/').replace('((?!ia\\/chat).*)', '((?!ia/chat).*)')}$`);
    expect(motif.test('/dashboard')).toBe(true);
    expect(motif.test('/login')).toBe(true);
    expect(motif.test('/ia/chat')).toBe(false);
  });
});

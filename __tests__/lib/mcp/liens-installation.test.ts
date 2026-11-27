import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { assistants, langueDe, liensInstallation, liensPublics } from '@/lib/mcp/liens-installation';

const env = { AUTH_URL: 'https://app.veridian.site' } as NodeJS.ProcessEnv;
const L = liensInstallation(env);

describe('liens « Ajouter à … » de la porte MCP', () => {
  it('une seule adresse pour toutes les apps : la porte du Hub', () => {
    expect(L.url).toBe('https://app.veridian.site/api/mcp');
  });
  it('Claude : format officiel, nom et adresse préremplis, adresse encodée', () => {
    const u = new URL(L.claude);
    expect(u.origin + u.pathname).toBe('https://claude.ai/customize/connectors');
    expect(u.searchParams.get('modal')).toBe('add-custom-connector');
    expect(u.searchParams.get('connectorName')).toBe('Veridian');
    expect(u.searchParams.get('connectorUrl')).toBe('https://app.veridian.site/api/mcp');
    expect(L.claude).toContain('connectorUrl=https%3A%2F%2Fapp.veridian.site%2Fapi%2Fmcp');
  });
  it('Cursor : configuration JSON en base64 qui pointe la porte', () => {
    const u = new URL(L.cursor);
    expect(JSON.parse(Buffer.from(u.searchParams.get('config')!, 'base64').toString())).toEqual({ url: L.url });
  });
  it('VS Code : serveur http qui pointe la porte', () => {
    const cible = new URL(L.vscode).searchParams.get('url')!;
    expect(cible.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(cible.slice('vscode:mcp/install?'.length)))).toEqual({ name: 'veridian', type: 'http', url: L.url });
  });
  it('Claude Code : une commande', () => {
    expect(L.claudeCode).toBe('claude mcp add --transport http veridian https://app.veridian.site/api/mcp');
  });
  it('aucun secret dans les liens', () => {
    expect(JSON.stringify(L)).not.toMatch(/token|secret|key=/i);
  });
});

describe('ChatGPT', () => {
  it('ouvre la page Plugins, et l\'étape nomme les boutons de la doc d\'OpenAI (25/11)', () => {
    expect(L.chatgpt).toBe('https://chatgpt.com/plugins');
    for (const mot of ['chatgpt.com/plugins', 'Add custom MCP server', 'OAuth', 'Create as a plugin']) expect(L.instructions.chatgpt).toContain(mot);
  });
});

describe('GET /api/mcp/liens-installation', () => {
  it('public, cache court, CORS ouvert ; liens et assistants', async () => {
    vi.doMock('@/lib/prisma', () => ({ prisma: { mcpApp: { findUnique: async () => null } } }));
    const { GET } = await import('@/app/api/mcp/liens-installation/route');
    const r = await GET(new NextRequest('https://app.veridian.site/api/mcp/liens-installation'));
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('vary')).toBe('Accept-Language');
    const corps = await r.json();
    expect(corps.url).toMatch(/\/api\/mcp$/);
    expect(corps.assistants.map((a: { cle: string }) => a.cle)).toEqual(['claude', 'chatgpt', 'cursor', 'vscode']);
    expect(corps.app).toBeNull();
  });
});

describe('liensPublics', () => {
  const db = (lignes: Record<string, { appKey: string; label: string; enabled: boolean }>) =>
    ({ mcpApp: { findUnique: async ({ where }: { where: { appKey: string } }) => lignes[where.appKey] ?? null } }) as never;
  const reg = db({
    prospection: { appKey: 'prospection', label: 'Prospection', enabled: true },
    vieille: { appKey: 'vieille', label: 'Vieille', enabled: false },
  });

  it('chaque assistant : libellé, lien, étape seulement pour ChatGPT', async () => {
    const r = await liensPublics(reg, null, env);
    expect(r.assistants.find((a) => a.cle === 'claude')).toEqual({ cle: 'claude', libelle: 'Ajouter à Claude', installation: r.claude, etape: null });
    expect(r.assistants.find((a) => a.cle === 'chatgpt')!.etape).toContain('OAuth');
    expect(r.instructions.chatgpt).toBe(r.assistants[1].etape);
  });
  it('app=<cle> du registre : mise en avant, le connecteur reste « Veridian »', async () => {
    const r = await liensPublics(reg, 'prospection', env);
    expect(r.app).toEqual({ cle: 'prospection', nom: 'Prospection', phrase: expect.stringContaining('Prospection') });
    expect(new URL(r.claude).searchParams.get('connectorName')).toBe('Veridian');
  });
  it('en anglais (Mail, 27/11 : console anglaise, boutons en français) : libellés, étape et phrase ; les liens ne changent pas', async () => {
    const fr = await liensPublics(reg, 'prospection', env, 'fr');
    const en = await liensPublics(reg, 'prospection', env, 'en');
    expect(en.assistants.map((a) => a.libelle)).toEqual(['Add to Claude', 'Open ChatGPT', 'Add to Cursor', 'Add to VS Code']);
    expect([en.assistants[1].etape?.startsWith('In ChatGPT'), en.app?.phrase.startsWith('One Veridian connection'), en.langue]).toEqual([true, true, 'en']);
    expect(en.assistants.map((a) => a.installation)).toEqual(fr.assistants.map((a) => a.installation));
  });
  it('clé inconnue, coupée ou mal formée : app null, liens rendus', async () => {
    for (const k of ['inconnue', 'vieille', "x'; drop", 'A'.repeat(50)]) {
      const r = await liensPublics(reg, k, env);
      expect(r.app).toBeNull();
      expect(r.url).toBe('https://app.veridian.site/api/mcp');
    }
  });
});

describe('langueDe', () => {
  it('?lang d\'abord, puis Accept-Language, le français par défaut ; une valeur inconnue ne compte pas', () => {
    expect([langueDe('en', 'fr-FR'), langueDe('fr', 'en-US'), langueDe(null, 'en-GB,en;q=0.9'), langueDe(null, 'fr-FR,en;q=0.8'), langueDe('de', null), langueDe(null, null)]).toEqual(['en', 'fr', 'en', 'fr', 'fr', 'fr']);
  });
});

describe('liensInstallation et assistants en anglais', () => {
  it('liensInstallation(env, en) : l\'étape ChatGPT en anglais, les liens identiques au français', () => {
    const fr = liensInstallation(env, 'fr');
    const en = liensInstallation(env, 'en');
    expect([en.instructions.chatgpt.startsWith('In ChatGPT'), en.claude === fr.claude, en.claudeCode === fr.claudeCode]).toEqual([true, true, true]);
  });
  it('assistants(l, en) : un libellé anglais par assistant, l\'étape seulement pour ChatGPT', () => {
    const a = assistants(liensInstallation(env, 'en'), 'en');
    expect(a.map((x) => [x.libelle, x.etape !== null])).toEqual([['Add to Claude', false], ['Open ChatGPT', true], ['Add to Cursor', false], ['Add to VS Code', false]]);
  });
});

import { describe, expect, it } from 'vitest';

import { liensInstallation } from '@/lib/mcp/liens-installation';

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

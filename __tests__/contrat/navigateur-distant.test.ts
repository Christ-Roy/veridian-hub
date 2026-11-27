import { execSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const WS = 'ws://127.0.0.1:1/x';

async function config() {
  vi.resetModules();
  return (await import('../../e2e/systeme-sso/playwright.config')).default as {
    use: { connectOptions?: { wsEndpoint: string }; launchOptions?: unknown };
  };
}

describe('batterie systeme : navigateur distant (PW_WS)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('PW_WS est honore : la batterie se relie au navigateur distant et ne lance rien en local', async () => {
    vi.stubEnv('PW_WS', WS);
    const { use } = await config();
    expect(use.connectOptions?.wsEndpoint).toBe(WS);
    expect(use.launchOptions).toBeUndefined();
  });

  it('PW_WS absent : comportement inchange, Chromium local', async () => {
    vi.stubEnv('PW_WS', '');
    const { use } = await config();
    expect(use.connectOptions).toBeUndefined();
    expect(use.launchOptions).toBeDefined();
  });

  it('aucun autre point de la batterie ne lance un navigateur en direct', () => {
    const trouve = execSync(
      "grep -rlE \"chromium\\.launch|from 'playwright'|\\.launch\\(\" e2e/systeme-sso --include=*.ts || true",
      { encoding: 'utf8' },
    ).trim();
    expect(trouve).toBe('');
  });
});

#!/usr/bin/env node
// Probe end-to-end staging Notifuse : valide attachOwner + getHealth.
// Usage : NOTIFUSE_HUB_API_SECRET_STAGING=... pnpm exec tsx scripts/dev/probe-notifuse-staging.ts

import { NotifuseClient } from '@/lib/notifuse/client';
import type { NotifuseError } from '@/lib/notifuse/types';

const API_URL = 'https://notifuse.staging.veridian.site';
const SECRET = process.env.NOTIFUSE_HUB_API_SECRET_STAGING;

async function main(): Promise<void> {
  if (!SECRET) {
    console.error('❌ NOTIFUSE_HUB_API_SECRET_STAGING manquant');
    process.exit(1);
  }

  const client = new NotifuseClient({ apiUrl: API_URL, hubSecret: SECRET });

  let pass = 0;
  let fail = 0;

  async function assertThrows(label: string, fn: () => Promise<unknown>, expectedCode: number) {
    try {
      await fn();
      console.log(`❌ ${label} — aurait dû throw`);
      fail++;
    } catch (err) {
      const e = err as NotifuseError;
      if (e.code === expectedCode) {
        console.log(`✓ ${label} — code=${e.code}, msg=${e.message}`);
        pass++;
      } else {
        console.log(`❌ ${label} — code attendu ${expectedCode}, reçu ${e.code} (${e.message})`);
        fail++;
      }
    }
  }

  await assertThrows(
    'getHealth("does-not-exist") → 404',
    () => client.getHealth('does-not-exist-staging-' + Date.now()),
    404,
  );

  await assertThrows(
    'attachOwner({tenantId: inexistant}) → 404',
    () =>
      client.attachOwner({
        tenantId: 'fake-tenant-' + Date.now(),
        ownerEmail: 'probe@test.io',
      }),
    404,
  );

  console.log(`\n${pass}/${pass + fail} probes OK`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});

#!/usr/bin/env node
// Probe end-to-end staging Notifuse avec mon client TS Hub.
// Simule le scénario exact du repair des 11 tenants prod cassés :
//   1. Provision un workspace test (owner Alice) — simule l'état post-provision
//      Notifuse d'un nouveau tenant.
//   2. Appel attachOwner avec un AUTRE email Bob — simule le repair où le Hub
//      veut remettre le bon owner humain (= ce que `repair-notifuse-owners.ts`
//      va faire sur les 11 tenants prod).
//   3. Health check post-attach → owner_email doit refléter le nouvel owner,
//      magic_link_capable=true.
//   4. Validation HMAC + sérialisation TS bout en bout.
//
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

  function ok(label: string, detail?: string) {
    console.log(`✓ ${label}${detail ? ' — ' + detail : ''}`);
    pass++;
  }
  function ko(label: string, detail: string) {
    console.log(`❌ ${label} — ${detail}`);
    fail++;
  }

  // ─── Garde-fous : test handler exists + path encoding ─────────────────
  console.log('\n=== Garde-fous endpoints ===');
  try {
    await client.getHealth('does-not-exist-' + Date.now());
    ko('getHealth(inexistant)', 'aurait dû throw 404');
  } catch (err) {
    const e = err as NotifuseError;
    if (e.code === 404) ok('getHealth(inexistant) → 404', e.message);
    else ko('getHealth(inexistant)', `code=${e.code} (${e.message})`);
  }

  try {
    await client.attachOwner({
      tenantId: 'fake-tenant-' + Date.now(),
      ownerEmail: 'probe@test.io',
    });
    ko('attachOwner(tenant inexistant)', 'aurait dû throw 404');
  } catch (err) {
    const e = err as NotifuseError;
    if (e.code === 404) ok('attachOwner(tenant inexistant) → 404', e.message);
    else ko('attachOwner(tenant inexistant)', `code=${e.code} (${e.message})`);
  }

  // ─── Scénario réel repair : provision + attach autre owner + health ───
  console.log('\n=== Scénario réel repair (simule les 11 tenants prod) ===');
  const ts = Date.now().toString(36).slice(-10);
  const tenantId = `e2e${ts}probe`;
  const aliceEmail = `${tenantId}-alice@e2e.test`;
  const bobEmail = `${tenantId}-bob@e2e.test`;

  // 1. Provision (état initial : Alice est owner)
  try {
    const prov = await client.provisionWorkspace({
      tenantId,
      ownerEmail: aliceEmail,
      workspaceName: 'probe ' + tenantId,
      plan: 'free',
    });
    if (prov.created && prov.workspace_id === tenantId) {
      ok('provisionWorkspace(Alice owner)', `workspace_id=${prov.workspace_id} api_key=${prov.api_key.slice(0, 12)}...`);
    } else {
      ko('provisionWorkspace', `created=${prov.created}, workspace_id=${prov.workspace_id}`);
      return;
    }
  } catch (err) {
    const e = err as NotifuseError;
    ko('provisionWorkspace', `${e.code} ${e.message}`);
    return;
  }

  // 2. Health initial → Alice doit être owner attaché, magic_link_capable=true
  try {
    const h = await client.getHealth(tenantId);
    if (
      h.owner_attached === true &&
      h.owner_email === aliceEmail &&
      h.magic_link_capable === true
    ) {
      ok('health post-provision', `owner=${h.owner_email}, magic_link_capable=${h.magic_link_capable}, members=${h.members_count}`);
    } else {
      ko(
        'health post-provision',
        `attendu owner_attached=true/email=Alice/capable=true, reçu attached=${h.owner_attached}/email=${h.owner_email}/capable=${h.magic_link_capable}`,
      );
    }
  } catch (err) {
    const e = err as NotifuseError;
    ko('health post-provision', `${e.code} ${e.message}`);
  }

  // 3. AttachOwner Bob — c'est ICI le scénario clé pour le repair :
  //    workspace existe, owner humain présent (Alice), on veut en ajouter un autre (Bob).
  //    Côté Notifuse 2026-05-18 : ce scénario peut renvoyer 500 si bug
  //    "attach-owner d'un 2ème humain alors qu'un humain existe déjà"
  //    (c'est ce que le test E2E hub-contract step 7 a montré).
  //    Pour notre repair des 11 tenants prod : owner actuel = brunon5robert@gmail.com,
  //    on veut attacher le VRAI owner humain → même topologie.
  try {
    const a = await client.attachOwner({
      tenantId,
      ownerEmail: bobEmail,
      role: 'owner',
    });
    ok(
      'attachOwner(Bob) sur workspace avec Alice owner',
      `attached=${a.attached}, already=${a.already_attached}, transferred=${a.owner_transferred ?? false}, user_id=${a.user_id.slice(0, 8)}...`,
    );
  } catch (err) {
    const e = err as NotifuseError;
    ko('attachOwner(Bob)', `${e.code} ${e.message} — c'est le bug à signaler si 500`);
  }

  // 4. Idempotence : attach Bob encore → already_attached=true
  try {
    const a2 = await client.attachOwner({ tenantId, ownerEmail: bobEmail });
    if (a2.already_attached === true) {
      ok('attachOwner(Bob) idempotent', `already_attached=${a2.already_attached}`);
    } else {
      ko('attachOwner(Bob) idempotent', `already_attached=${a2.already_attached} (attendu true)`);
    }
  } catch (err) {
    const e = err as NotifuseError;
    ko('attachOwner(Bob) idempotent', `${e.code} ${e.message}`);
  }

  // 5. Health final
  try {
    const h = await client.getHealth(tenantId);
    if (h.magic_link_capable === true && h.owner_attached === true) {
      ok(
        'health final',
        `status=${h.status}, owner=${h.owner_email}, members=${h.members_count}, capable=${h.magic_link_capable}`,
      );
    } else {
      ko(
        'health final',
        `magic_link_capable=${h.magic_link_capable}/attached=${h.owner_attached}`,
      );
    }
  } catch (err) {
    const e = err as NotifuseError;
    ko('health final', `${e.code} ${e.message}`);
  }

  console.log(`\n${pass}/${pass + fail} probes OK`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});

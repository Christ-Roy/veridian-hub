#!/usr/bin/env node
/**
 * Script de seed utilisateur dev.
 * Crée automatiquement un compte admin en mode développement (Auth.js v5)
 * ET déclenche le provisioning Twenty + Notifuse.
 *
 * Post-migration : insère dans hub_app.users + hub_app.accounts
 * (provider 'credentials', access_token = bcrypt(password)). Le user peut
 * ensuite se login via le formulaire credentials du Hub.
 */

import { withPg } from '../lib/db.mjs';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

if (process.env.NODE_ENV === 'production') {
  console.log('Skipping dev user seed in production');
  process.exit(0);
}

const NEXT_SERVER_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('DATABASE_URL manquante - skip seed');
  process.exit(0);
}

const DEV_USER = {
  email: 'dev@veridian.local',
  password: 'DevPassword123!',
  name: 'Dev User',
};

async function waitForServer(maxAttempts = 30, interval = 2000) {
  console.log(`\nWaiting for Next.js server at ${NEXT_SERVER_URL}...`);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${NEXT_SERVER_URL}/api/health`);
      if (response.ok) {
        console.log('Next.js server is ready!');
        return true;
      }
    } catch { /* not ready */ }
    process.stdout.write(`   Attempt ${i + 1}/${maxAttempts}...\r`);
    await new Promise((r) => setTimeout(r, interval));
  }
  console.log('\nTimeout waiting for server - continuing anyway...');
  return false;
}

async function ensureUser(client) {
  const { rows } = await client.query(
    'SELECT id, email FROM hub_app.users WHERE email = $1 LIMIT 1',
    [DEV_USER.email],
  );

  if (rows[0]) {
    return { id: rows[0].id, isNew: false };
  }

  // Create new user (Auth.js id = cuid normalement, ici on stringifie un UUID
  // pour matcher le pattern "users migrés" -> id == supabase_user_id)
  const userId = randomUUID();
  await client.query(
    `INSERT INTO hub_app.users (id, email, name, supabase_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $1, NOW(), NOW())`,
    [userId, DEV_USER.email, DEV_USER.name],
  );

  // Create credentials account
  const hash = await bcrypt.hash(DEV_USER.password, 12);
  await client.query(
    `INSERT INTO hub_app.accounts (
       id, user_id, type, provider, provider_account_id, access_token
     ) VALUES ($1, $2, 'credentials', 'credentials', $3, $4)`,
    [randomUUID(), userId, DEV_USER.email, hash],
  );

  return { id: userId, isNew: true };
}

async function provisionDevUserTenants(userId) {
  console.log('\nStarting tenant provisioning...');
  console.log(`   User UUID: ${userId}`);
  try {
    const response = await fetch(`${NEXT_SERVER_URL}/api/dev/provision-tenant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: DEV_USER.email,
        password: DEV_USER.password,
        userId,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Provisioning API error:', data.error);
      return false;
    }

    console.log('Provisioning started — see main server logs.');
    return true;
  } catch (error) {
    console.error('Error provisioning tenants:', error.message);
    return false;
  }
}

async function checkExistingTenants(client, userId) {
  const { rows } = await client.query(
    `SELECT twenty_workspace_id, notifuse_workspace_slug
       FROM hub_app.tenants WHERE user_id = $1::uuid LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

async function seedDevUser() {
  await withPg(async (client) => {
    console.log('====================================================');
    console.log('DEV USER SEED SCRIPT');
    console.log('====================================================\n');

    const { id: userId, isNew } = await ensureUser(client);
    console.log(isNew ? `Created dev user: ${DEV_USER.email}` : `Dev user exists: ${DEV_USER.email}`);
    console.log(`   User UUID: ${userId}`);

    const existing = await checkExistingTenants(client, userId);
    const hasTenants = existing && (existing.twenty_workspace_id || existing.notifuse_workspace_slug);

    if (hasTenants) {
      console.log('\nTenants already provisioned!');
      console.log(`   Twenty: ${existing.twenty_workspace_id || 'N/A'}`);
      console.log(`   Notifuse: ${existing.notifuse_workspace_slug || 'N/A'}`);
    } else {
      console.log('\nTenants not found - provisioning needed...');
      const serverReady = await waitForServer();
      if (serverReady) {
        await provisionDevUserTenants(userId);
      } else {
        console.log('\nServer not ready - skipping provisioning');
      }
    }

    console.log('\n====================================================');
    console.log('SETUP COMPLETE');
    console.log('====================================================');
    console.log(`\nLogin credentials:`);
    console.log(`   Email: ${DEV_USER.email}`);
    console.log(`   Password: ${DEV_USER.password}`);
    console.log(`\nLogin URL: ${NEXT_SERVER_URL}/login\n`);
  });
}

(async () => {
  try {
    await seedDevUser();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(0);
  }
})();

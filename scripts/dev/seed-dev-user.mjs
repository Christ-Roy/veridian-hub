#!/usr/bin/env node
/**
 * Script de seed utilisateur dev
 * Crée automatiquement un compte admin en mode développement
 * ET provisionne automatiquement les tenants Twenty + Notifuse
 */

import { createClient } from '@supabase/supabase-js';
import http from 'http';

// Only run in development
if (process.env.NODE_ENV === 'production') {
  console.log('⏭️  Skipping dev user seed in production');
  process.exit(0);
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NEXT_SERVER_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log('⚠️  Variables Supabase manquantes - skip seed');
  process.exit(0);
}

// Default dev user credentials
const DEV_USER = {
  email: 'dev@veridian.local',
  password: 'DevPassword123!',
  full_name: 'Dev User',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Wait for Next.js server to be ready
 */
async function waitForServer(maxAttempts = 30, interval = 2000) {
  console.log(`\n⏳ Waiting for Next.js server at ${NEXT_SERVER_URL}...`);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${NEXT_SERVER_URL}/api/health`);
      if (response.ok) {
        console.log('✅ Next.js server is ready!');
        return true;
      }
    } catch (error) {
      // Server not ready yet
    }

    process.stdout.write(`   Attempt ${i + 1}/${maxAttempts}...\r`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  console.log('\n⚠️  Timeout waiting for server - continuing anyway...');
  return false;
}

/**
 * Provision tenants for dev user
 */
async function provisionDevUserTenants(userId) {
  console.log('\n🚀 Starting tenant provisioning...');
  console.log(`   User ID: ${userId}`);
  console.log(`   Email: ${DEV_USER.email}`);

  try {
    const response = await fetch(`${NEXT_SERVER_URL}/api/dev/provision-tenant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: DEV_USER.email,
        password: DEV_USER.password,
        userId: userId,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Provisioning API error:', data.error);
      return false;
    }

    console.log('✅ Provisioning started successfully!');
    console.log('   Check the main server logs for detailed progress...');

    // Wait a bit for provisioning to complete
    console.log('\n⏳ Waiting for provisioning to complete (30s)...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Check if tenants were created
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      console.log('⚠️  Could not verify tenant creation:', error.message);
      return false;
    }

    console.log('\n✅ Tenants provisioned successfully!');
    console.log('   Twenty Workspace:', tenants.twenty_workspace_id || 'N/A');
    console.log('   Twenty Subdomain:', tenants.twenty_subdomain || 'N/A');
    console.log('   Notifuse Workspace:', tenants.notifuse_workspace_slug || 'N/A');

    return true;
  } catch (error) {
    console.error('❌ Error provisioning tenants:', error.message);
    return false;
  }
}

async function seedDevUser() {
  try {
    console.log('════════════════════════════════════════════════════');
    console.log('🌱 DEV USER SEED SCRIPT');
    console.log('════════════════════════════════════════════════════\n');

    console.log('👤 Checking if dev user exists...');

    // Check if user already exists
    const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();

    if (listError) {
      console.error('❌ Error listing users:', listError.message);
      return;
    }

    const existingUser = existingUsers.users.find(u => u.email === DEV_USER.email);
    let userId = null;
    let isNewUser = false;

    if (existingUser) {
      console.log(`✅ Dev user already exists: ${DEV_USER.email}`);
      console.log(`   User ID: ${existingUser.id}`);
      userId = existingUser.id;
    } else {
      console.log('🔨 Creating dev user...');

      // Create user with admin API (bypasses email verification)
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: DEV_USER.email,
        password: DEV_USER.password,
        email_confirm: true, // Auto-confirm email
        user_metadata: {
          full_name: DEV_USER.full_name,
        },
      });

      if (createError) {
        console.error('❌ Error creating user:', createError.message);
        return;
      }

      console.log(`✅ Dev user created successfully!`);
      console.log(`   User ID: ${newUser.user.id}`);
      userId = newUser.user.id;
      isNewUser = true;
    }

    // Check if tenants already exist
    const { data: existingTenants, error: tenantError } = await supabase
      .from('tenants')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    const hasTenants = existingTenants && (
      existingTenants.twenty_workspace_id ||
      existingTenants.notifuse_workspace_slug
    );

    if (hasTenants) {
      console.log('\n✅ Tenants already provisioned!');
      console.log(`   Twenty: ${existingTenants.twenty_workspace_id || 'N/A'}`);
      console.log(`   Notifuse: ${existingTenants.notifuse_workspace_slug || 'N/A'}`);
    } else {
      console.log('\n🔧 Tenants not found - provisioning needed...');

      // Wait for Next.js server to be ready
      const serverReady = await waitForServer();

      if (serverReady) {
        // Provision tenants
        await provisionDevUserTenants(userId);
      } else {
        console.log('\n⚠️  Server not ready - skipping provisioning');
        console.log('   You can manually provision later via:');
        console.log(`   POST ${NEXT_SERVER_URL}/api/dev/provision-tenant`);
      }
    }

    // Final summary
    console.log('\n════════════════════════════════════════════════════');
    console.log('✅ SETUP COMPLETE');
    console.log('════════════════════════════════════════════════════');
    console.log(`\n📝 Login credentials:`);
    console.log(`   Email: ${DEV_USER.email}`);
    console.log(`   Password: ${DEV_USER.password}`);
    console.log(`\n🌐 Login URL: ${NEXT_SERVER_URL}/signin`);
    console.log(`\n💡 TIP: Use these credentials to login and access your tenants!\n`);

  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
    console.error('   Stack:', error.stack);
  }
}

// Main execution
(async () => {
  try {
    await seedDevUser();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(0); // Don't block container startup
  }
})();

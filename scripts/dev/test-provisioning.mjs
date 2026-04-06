#!/usr/bin/env node

/**
 * 🧪 TEST PROVISIONING - Script de Développement
 *
 * USAGE:
 *   node scripts/dev/test-provisioning.mjs test@example.com MyPassword123
 *
 * SÉCURITÉ:
 *   - ⚠️ DEV ONLY - Ne pas utiliser en production
 *   - Nécessite NODE_ENV=development
 *   - Utilise SERVICE_ROLE_KEY (accès total)
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://api.51.210.7.44.nip.io';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Security check
if (process.env.NODE_ENV === 'production') {
  console.error('❌ ERROR: This script is for development only!');
  console.error('   Set NODE_ENV=development to run this script.');
  process.exit(1);
}

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ ERROR: SUPABASE_SERVICE_ROLE_KEY not set');
  console.error('   This script requires the service role key.');
  process.exit(1);
}

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('❌ ERROR: Missing arguments');
  console.error('');
  console.error('Usage:');
  console.error('  node scripts/dev/test-provisioning.mjs <email> <password>');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/dev/test-provisioning.mjs test@example.com MyPassword123');
  console.error('');
  process.exit(1);
}

console.log('🧪 TEST PROVISIONING - Development Script');
console.log('=========================================');
console.log('');
console.log(`Email: ${email}`);
console.log(`Password: ${password.substring(0, 3)}${'*'.repeat(password.length - 3)}`);
console.log('');

async function main() {
  try {
    // Step 1: Create test user in Supabase
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📝 STEP 1: Creating test user in Supabase');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    const signupResponse = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        options: {
          emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/auth/callback`,
        },
      }),
    });

    const signupData = await signupResponse.json();

    if (signupData.error) {
      if (signupData.error.message?.includes('already registered')) {
        console.log('⚠️  User already exists');
        console.log('   Fetching existing user...');

        // Get user via admin API
        const adminResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
        });

        const adminData = await adminResponse.json();
        if (adminData.users && adminData.users.length > 0) {
          var userId = adminData.users[0].id;
          console.log('✅ Existing user found:', userId);
        } else {
          throw new Error('User exists but could not fetch it');
        }
      } else {
        throw new Error(`Signup failed: ${signupData.error.message}`);
      }
    } else {
      var userId = signupData.user.id;
      console.log('✅ User created successfully');
      console.log('   User ID:', userId);
      console.log('   Email confirmed:', signupData.user.email_confirmed_at ? 'YES' : 'NO');
    }

    console.log('');

    // Step 2: Call provisioning endpoint
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 STEP 2: Calling provisioning endpoint');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log(`   URL: ${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/provision-tenants`);
    console.log('   Starting provisioning...');
    console.log('');

    // Import the provisioning function directly
    const { provisionTenants } = await import('../../utils/tenants/provision.ts');

    const result = await provisionTenants(email, password, userId);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 PROVISIONING RESULTS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('Overall Success:', result.success ? '✅ YES' : '❌ NO');
    console.log('');

    if (result.twenty) {
      console.log('Twenty CRM:');
      console.log('  Success:', result.twenty.success ? '✅' : '❌');
      if (result.twenty.success) {
        console.log('  Workspace ID:', result.twenty.workspaceId);
        console.log('  Subdomain:', result.twenty.subdomain);
        console.log('  API Key:', result.twenty.apiKey?.substring(0, 30) + '...');
        console.log('  Login Token:', result.twenty.loginToken?.substring(0, 30) + '...');
      } else {
        console.log('  Error:', result.twenty.error);
      }
      console.log('');
    }

    if (result.notifuse) {
      console.log('Notifuse:');
      console.log('  Success:', result.notifuse.success ? '✅' : '❌');
      if (result.notifuse.success) {
        console.log('  Workspace ID:', result.notifuse.workspaceId);
        console.log('  API Key:', result.notifuse.apiKey?.substring(0, 30) + '...');
      } else {
        console.log('  Error:', result.notifuse.error);
      }
      console.log('');
    }

    if (result.errors && result.errors.length > 0) {
      console.log('Errors:');
      result.errors.forEach(err => console.log('  -', err));
      console.log('');
    }

    // Step 3: Verify in Supabase
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 STEP 3: Verifying in Supabase');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    const verifyResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/tenants?user_id=eq.${userId}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );

    const tenants = await verifyResponse.json();

    if (tenants && tenants.length > 0) {
      const tenant = tenants[0];
      console.log('✅ Tenant found in database:');
      console.log('');
      console.log('  ID:', tenant.id);
      console.log('  Name:', tenant.name);
      console.log('  Status:', tenant.status);
      console.log('  Twenty Workspace:', tenant.twenty_workspace_id || '❌ Not configured');
      console.log('  Twenty Subdomain:', tenant.twenty_subdomain || 'N/A');
      console.log('  Twenty API Key:', tenant.twenty_api_key ? '✅ Stored' : '❌ Missing');
      console.log('  Twenty Password:', tenant.twenty_user_password ? '✅ Stored' : '❌ Missing');
      console.log('  Notifuse Workspace:', tenant.notifuse_workspace_slug || '❌ Not configured');
      console.log('  Notifuse API Key:', tenant.notifuse_api_key ? '✅ Stored' : '❌ Missing');
      console.log('');
    } else {
      console.log('❌ No tenant found in database');
      console.log('');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 TEST COMPLETED');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Check the logs above for any errors');
    console.log(`  2. Login to the dashboard: ${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/signin`);
    console.log(`  3. Navigate to: ${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/dashboard`);
    console.log('  4. Verify tenants are visible and functional');
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ TEST FAILED');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('');
    console.error('Error:', error.message);
    console.error('');
    if (error.stack) {
      console.error('Stack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();

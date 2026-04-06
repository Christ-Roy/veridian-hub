/**
 * Debug utilities for tenant provisioning
 * Only logs in development mode
 */

const isDev = process.env.NODE_ENV !== 'production';

export function logProvisionStart(email: string, userId: string) {
  if (!isDev) return;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 PROVISIONING STARTED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Email: ${email}`);
  console.log(`User ID: ${userId}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');
  console.log('📡 Environment Variables:');
  console.log(`  TWENTY_GRAPHQL_URL: ${process.env.TWENTY_GRAPHQL_URL || 'NOT SET'}`);
  console.log(`  TWENTY_METADATA_URL: ${process.env.TWENTY_METADATA_URL || 'NOT SET'}`);
  console.log(`  TWENTY_FRONTEND_URL: ${process.env.TWENTY_FRONTEND_URL || 'NOT SET'}`);
  console.log(`  NOTIFUSE_API_URL: ${process.env.NOTIFUSE_API_URL || 'NOT SET'}`);
  console.log(`  NOTIFUSE_ROOT_EMAIL: ${process.env.NOTIFUSE_ROOT_EMAIL || 'NOT SET'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

export function logProvisionEnd(success: boolean, duration: number, errors?: string[]) {
  if (!isDev) {
    // En production, logger seulement les erreurs
    if (!success && errors && errors.length > 0) {
      console.error('[Provisioning] Failed:', { duration, errors });
    }
    return;
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(success ? '✅ PROVISIONING COMPLETED' : '❌ PROVISIONING FAILED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
  if (errors && errors.length > 0) {
    console.log('Errors:');
    errors.forEach((err) => console.log(`  - ${err}`));
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

export function logStep(service: string, step: string, data?: any) {
  if (!isDev) return;

  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] [${service}] ${step}`, data || '');
}

export function logError(service: string, error: any) {
  // Les erreurs sont toujours loggées, même en prod
  console.error(`[${service}] ❌ ERROR:`, error.message || error);

  if (isDev && error.stack) {
    console.error(`[${service}] Stack trace:`, error.stack);
  }
}

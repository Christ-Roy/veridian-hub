/**
 * TEST ROUTE - Index des tests disponibles
 *
 * Usage:
 *   curl http://localhost:3000/api/test
 *
 * Liste tous les tests disponibles
 */

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    message: 'API Test Routes',
    availableTests: [
      {
        name: 'Create Twenty Tenant',
        endpoint: '/api/test/create-twenty',
        method: 'GET',
        description: 'Crée automatiquement un tenant Twenty CRM complet avec API key',
        returns: [
          'workspace (id, displayName, url)',
          'credentials (email, password)',
          'apiKey (id, token, expiresAt)',
          'autoLoginUrl',
          'logs (détaillés)',
        ],
      },
      {
        name: 'Create Notifuse Tenant',
        endpoint: '/api/test/create-notifuse',
        method: 'GET',
        description: 'Crée automatiquement un tenant Notifuse avec admin et magic link',
        returns: [
          'workspace (id, name)',
          'apiKey (token, email)',
          'admin (email, userId)',
          'magicLink',
          'magicCode',
          'logs (détaillés)',
        ],
      },
    ],
    productionEndpoints: [
      {
        name: 'Create Twenty Tenant (Production)',
        endpoint: '/api/twenty/create-tenant',
        method: 'POST',
        body: {
          email: 'user@example.com',
          password: 'SecurePass123!',
          workspaceName: 'My Company',
        },
      },
      {
        name: 'Regenerate Twenty Login',
        endpoint: '/api/twenty/regenerate-login',
        method: 'POST',
        body: {
          email: 'user@example.com',
          password: 'SecurePass123!',
        },
      },
      {
        name: 'Create Notifuse Tenant (Production)',
        endpoint: '/api/notifuse/create-tenant',
        method: 'POST',
        body: {
          workspaceId: 'mycompany',
          workspaceName: 'My Company',
        },
      },
    ],
    examples: {
      testTwenty: 'curl http://localhost:3000/api/test/create-twenty | jq .',
      testNotifuse: 'curl http://localhost:3000/api/test/create-notifuse | jq .',
      createTwentyProd:
        'curl -X POST http://localhost:3000/api/twenty/create-tenant -H "Content-Type: application/json" -d \'{"email":"test@example.com","password":"SecurePass123!","workspaceName":"Test Workspace"}\' | jq .',
      createNotifuseProd:
        'curl -X POST http://localhost:3000/api/notifuse/create-tenant -H "Content-Type: application/json" -d \'{"workspaceId":"testcompany","workspaceName":"Test Company"}\' | jq .',
    },
  });
}

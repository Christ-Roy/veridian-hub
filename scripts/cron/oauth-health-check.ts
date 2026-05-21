#!/usr/bin/env node
/**
 * Cron mensuel — OAuth health check
 *
 * Vérifie 2 invariants critiques pour le flow OAuth Hub :
 *   1. Le secret Microsoft Entra n'expire pas dans les 90 prochains jours
 *      (rotation à anticiper, cf. reference_microsoft_entra_oauth.md).
 *      Le secret actuel expire 2028-05-20.
 *   2. Le discovery doc Google répond et l'`issuer` est conforme.
 *
 * En cas de problème → exit 1 + alerte Telegram via le bot Veridian.
 *
 * Variables d'environnement requises (injectées par le workflow CI) :
 *   - TELEGRAM_BOT_TOKEN (secret GitHub Actions, identique au pattern hub-staging.yml)
 *   - TELEGRAM_CHAT_ID (idem)
 *
 * Variables optionnelles :
 *   - MICROSOFT_OAUTH_TENANT_ID, MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET
 *     → si présents, on appelle Microsoft Graph pour récupérer les credentials
 *       et leur date d'expiration. Sinon on skip le check Microsoft (warn).
 *   - OAUTH_HEALTH_WARN_DAYS (défaut 90)
 *
 * Usage local :
 *   tsx scripts/cron/oauth-health-check.ts
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WARN_DAYS = Number(process.env.OAUTH_HEALTH_WARN_DAYS ?? '90');

const MICROSOFT_TENANT_ID = process.env.MICROSOFT_OAUTH_TENANT_ID;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_OAUTH_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
const MICROSOFT_OBJECT_ID = process.env.MICROSOFT_OAUTH_OBJECT_ID;

const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const EXPECTED_GOOGLE_ISSUER = 'https://accounts.google.com';

export interface HealthCheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export async function sendTelegramAlert(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('  (Telegram non configuré — alerte non envoyée)');
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown',
        }),
      },
    );
    if (!res.ok) {
      console.error(`  Telegram API non-200 : ${res.status}`);
    }
  } catch (err) {
    console.error('  Échec envoi Telegram :', err);
  }
}

export async function checkGoogleDiscovery(): Promise<HealthCheckResult> {
  try {
    const res = await fetch(GOOGLE_DISCOVERY_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        check: 'google-discovery',
        ok: false,
        detail: `HTTP ${res.status} sur ${GOOGLE_DISCOVERY_URL}`,
      };
    }
    const body = (await res.json()) as { issuer?: string };
    if (body.issuer !== EXPECTED_GOOGLE_ISSUER) {
      return {
        check: 'google-discovery',
        ok: false,
        detail: `Issuer inattendu : ${body.issuer} (attendu ${EXPECTED_GOOGLE_ISSUER})`,
      };
    }
    return {
      check: 'google-discovery',
      ok: true,
      detail: `issuer=${body.issuer}`,
    };
  } catch (err) {
    return {
      check: 'google-discovery',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getMicrosoftAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Token MS OAuth HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Pas de access_token retourné');
  }
  return data.access_token;
}

interface GraphPasswordCredential {
  endDateTime?: string;
  displayName?: string;
  keyId?: string;
}

export async function checkMicrosoftSecretExpiry(): Promise<HealthCheckResult> {
  if (!MICROSOFT_TENANT_ID || !MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    return {
      check: 'microsoft-secret-expiry',
      ok: true,
      detail: 'skip (creds Microsoft non fournis au cron)',
    };
  }
  const objectId = MICROSOFT_OBJECT_ID;
  if (!objectId) {
    return {
      check: 'microsoft-secret-expiry',
      ok: false,
      detail: 'MICROSOFT_OAUTH_OBJECT_ID manquant — impossible de lire les credentials via Graph',
    };
  }

  try {
    const token = await getMicrosoftAccessToken(
      MICROSOFT_TENANT_ID,
      MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET,
    );

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/applications/${objectId}?$select=passwordCredentials`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      return {
        check: 'microsoft-secret-expiry',
        ok: false,
        detail: `Graph HTTP ${res.status} sur applications/${objectId}`,
      };
    }
    const data = (await res.json()) as { passwordCredentials?: GraphPasswordCredential[] };
    const creds = data.passwordCredentials ?? [];
    if (creds.length === 0) {
      return {
        check: 'microsoft-secret-expiry',
        ok: false,
        detail: 'Aucun passwordCredential — App Registration probablement cassée',
      };
    }
    // Le plus tardif des secrets actifs (celui sur lequel on tient)
    const now = Date.now();
    const future = creds
      .map((c) => ({ ...c, endMs: c.endDateTime ? Date.parse(c.endDateTime) : 0 }))
      .filter((c) => c.endMs > now)
      .sort((a, b) => b.endMs - a.endMs);
    if (future.length === 0) {
      return {
        check: 'microsoft-secret-expiry',
        ok: false,
        detail: 'TOUS les secrets Microsoft sont expirés',
      };
    }
    const next = future[0];
    const daysRemaining = Math.floor((next.endMs - now) / (1000 * 60 * 60 * 24));
    if (daysRemaining < WARN_DAYS) {
      return {
        check: 'microsoft-secret-expiry',
        ok: false,
        detail: `Secret Microsoft "${next.displayName ?? next.keyId}" expire dans ${daysRemaining}j (seuil ${WARN_DAYS}j)`,
      };
    }
    return {
      check: 'microsoft-secret-expiry',
      ok: true,
      detail: `Secret "${next.displayName ?? next.keyId}" valide ${daysRemaining}j`,
    };
  } catch (err) {
    return {
      check: 'microsoft-secret-expiry',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runHealthChecks(): Promise<HealthCheckResult[]> {
  return Promise.all([checkGoogleDiscovery(), checkMicrosoftSecretExpiry()]);
}

async function main(): Promise<void> {
  console.log('🔍 OAuth health check — démarrage');

  const results = await runHealthChecks();

  for (const r of results) {
    const icon = r.ok ? '✓' : '❌';
    console.log(`  ${icon} ${r.check} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    console.log('✓ All checks pass.');
    return;
  }

  const msg =
    `🚨 *OAuth health check FAIL* (Hub Veridian)\n\n` +
    failed.map((r) => `• \`${r.check}\` : ${r.detail}`).join('\n') +
    `\n\nRunbook : \`runbooks/services/hub/oauth-smoke.md\``;

  await sendTelegramAlert(msg);

  process.exit(1);
}

const isMain =
  typeof import.meta !== 'undefined' &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('Erreur fatale :', err);
    process.exit(1);
  });
}

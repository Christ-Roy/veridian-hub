/**
 * Client engine Analytics — pull `export.userEvents` (porté du bridge
 * `veridian-tunnel-de-vente/bridge/src/engine-client.ts`).
 *
 * Le Hub n'a pas d'accès ClickHouse direct : il consomme l'export REST de
 * l'engine Analytics, paginé par curseur, sur une fenêtre temporelle bornée
 * par l'appelant (cf `analytics-pull.ts`, fenêtre fixe de 48 h).
 *
 * Auth : pas d'API key possible sur un workspace platform-managed (403 vérifié
 * côté bridge 2026-06-10) → login super-admin programmatique, token 7 j,
 * re-login automatique sur 401. Les credentials viennent de l'ENV :
 *   - ENGINE_BASE_URL      (défaut https://analytics-engine.app.veridian.site)
 *   - ENGINE_WORKSPACE_ID  (défaut vrd_veridian_site_prod)
 *   - ENGINE_ADMIN_EMAIL / ENGINE_ADMIN_PASSWORD (requis pour pull réel)
 *
 * Si les credentials admin sont absents, `isConfigured()` renvoie false et le
 * cron skip proprement le pull (0 event, pas d'erreur) — même garde-fou que le
 * bridge.
 */

/** Ligne `export.userEvents` (sous-ensemble utile au scoring). */
export interface ExportedEvent {
  id: string;
  session_id: string;
  user_id: string;
  name: 'screen_view' | 'goal';
  path: string;
  created_at: string;
  updated_at: string;
  goal_name: string;
  goal_value: number;
  goal_timestamp: string | null;
  max_scroll: number;
  duration: number;
  /** properties libres (depuis fix G1 export — d794b95 côté engine) */
  properties?: Record<string, string>;
}

interface ExportResponse {
  data: ExportedEvent[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Config du client, résolue depuis l'ENV. */
export interface EngineClientConfig {
  baseUrl: string;
  workspaceId: string;
  adminEmail: string;
  adminPassword: string;
}

/** Résout la config depuis l'ENV (zéro secret en dur). */
export function engineConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EngineClientConfig {
  return {
    baseUrl:
      env.ENGINE_BASE_URL ?? 'https://analytics-engine.app.veridian.site',
    workspaceId: env.ENGINE_WORKSPACE_ID ?? 'vrd_veridian_site_prod',
    adminEmail: env.ENGINE_ADMIN_EMAIL ?? '',
    adminPassword: env.ENGINE_ADMIN_PASSWORD ?? ''
  };
}

export class EngineClient {
  private readonly config: EngineClientConfig;
  private token: string | null = null;

  constructor(config: EngineClientConfig) {
    this.config = config;
  }

  /** True si les credentials admin sont présents (sinon le pull est skippé). */
  isConfigured(): boolean {
    return (
      this.config.adminEmail.length > 0 && this.config.adminPassword.length > 0
    );
  }

  private async login(): Promise<string> {
    const res = await fetch(new URL('/api/auth.login', this.config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.config.adminEmail,
        password: this.config.adminPassword
      })
    });
    if (!res.ok) {
      throw new Error(`engine login ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      access_token?: string;
      token?: string;
    };
    const token = body.access_token ?? body.token;
    if (!token) throw new Error('engine login: pas de token dans la réponse');
    this.token = token;
    return token;
  }

  /**
   * Une page d'export. `since` OU `cursor` requis côté API.
   * Retry une fois sur 401 (token expiré → re-login).
   */
  async exportPage(params: {
    since?: string;
    cursor?: string;
    until: string;
    limit?: number;
  }): Promise<ExportResponse> {
    const token = this.token ?? (await this.login());
    const url = new URL('/api/export.userEvents', this.config.baseUrl);
    url.searchParams.set('workspace_id', this.config.workspaceId);
    url.searchParams.set('until', params.until);
    url.searchParams.set('limit', String(params.limit ?? 1000));
    if (params.cursor) url.searchParams.set('cursor', params.cursor);
    else if (params.since) url.searchParams.set('since', params.since);

    let res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 401) {
      const fresh = await this.login();
      res = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }
    if (!res.ok) {
      throw new Error(`export.userEvents ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as ExportResponse;
  }

  /** Pull complet par curseur depuis `since` (borné par l'appelant). */
  async *exportAll(
    since: string,
    until: string
  ): AsyncGenerator<ExportedEvent[]> {
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const page: ExportResponse = await this.exportPage(
        cursor ? { cursor, until } : { since, until }
      );
      if (page.data.length > 0) yield page.data;
      cursor = page.next_cursor;
      hasMore = page.has_more && cursor !== null;
    }
  }
}

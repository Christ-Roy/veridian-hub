/**
 * Helper d'alerte Telegram pour le runtime applicatif Hub.
 *
 * Usage : remonter à Robert via Telegram un événement opérationnel critique
 * (app downstream down après retry, désync billing détectée, etc.). Pas
 * pour la trace verbeuse — on log dans la console pour ça.
 *
 * Convention :
 *   - ENV `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (cf workflows hub-staging.yml)
 *   - Si l'une des deux manque → no-op + warn (jamais throw, ne JAMAIS faire
 *     planter une route applicative pour un échec de notif)
 *   - Best-effort : retry 1× sur 5xx Telegram, puis abandon silencieux
 *
 * NB : cette fonction est appelée depuis un dispatcher async (webhook Stripe
 * notamment). Elle ne doit JAMAIS throw — sinon on bloque le 200 attendu
 * par Stripe et on déclenche un retry qui repassera par les mêmes alertes.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export interface TelegramOptions {
  botToken?: string;
  chatId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Envoie un message Telegram via l'API Bot. Best-effort.
 *
 * @returns true si Telegram a accepté le message, false sinon (ENV manquant,
 *          réseau down, Telegram 5xx). Ne throw jamais.
 */
export async function sendTelegramAlert(
  message: string,
  opts: TelegramOptions = {},
): Promise<boolean> {
  const botToken = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!botToken || !chatId) {
    console.warn(
      '[telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant — alerte ignorée:',
      message.slice(0, 80),
    );
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML' as const,
    disable_web_page_preview: true,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        return true;
      }

      // 5xx → retry une fois
      if (res.status >= 500 && attempt === 0) {
        continue;
      }

      const body = await safeReadText(res);
      console.warn(
        `[telegram] sendMessage failed status=${res.status} body=${body.slice(0, 200)}`,
      );
      return false;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[telegram] sendMessage error (non-blocking):', msg);
      return false;
    }
  }

  return false;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

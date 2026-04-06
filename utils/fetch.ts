/**
 * Fetch wrapper for Docker Traefik routing
 *
 * In Docker, lvh.me resolves to 127.0.0.1 (container itself).
 * This wrapper routes lvh.me requests through Traefik service with proper Host header.
 */

export async function fetch(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);

  // Route lvh.me domains through Traefik in Docker
  if (urlStr.includes('.lvh.me')) {
    const urlObj = new URL(urlStr);
    const traefikUrl = `http://traefik:80${urlObj.pathname}${urlObj.search}`;

    return global.fetch(traefikUrl, {
      ...options,
      headers: {
        ...(options?.headers || {}),
        'Host': urlObj.host,
      },
    });
  }

  // Normal fetch
  return global.fetch(url, options);
}

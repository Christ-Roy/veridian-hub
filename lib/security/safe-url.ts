/**
 * Defense-in-depth SSRF guard for any URL accepted from external input
 * (admin endpoints, HMAC routes, redirect helpers).
 *
 * Strategy : parse via `new URL()` → normalise the hostname → reject if it
 * resolves to a known-internal address class. Pure string blacklists are
 * trivially bypassed (URL-encoding, decimal IPv4, longhand IPv6) so we MUST
 * normalise before checking.
 *
 * Limitations explicitly accepted :
 *  - No DNS resolution : `attacker.com` resolving to 127.0.0.1 is not blocked
 *    by this helper (would require an async DNS check + rebinding protection).
 *  - No HTTP fetch is performed here ; the helper validates input shape only.
 */

import { isIP, isIPv4, isIPv6 } from 'node:net';

export type SafeUrlError =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'empty_hostname'
  | 'blocked_hostname'
  | 'private_ipv4'
  | 'loopback_ipv4'
  | 'link_local_ipv4'
  | 'unspecified_ipv4'
  | 'broadcast_ipv4'
  | 'loopback_ipv6'
  | 'link_local_ipv6'
  | 'unique_local_ipv6'
  | 'unspecified_ipv6'
  | 'ipv4_mapped_ipv6';

export class UnsafeUrlError extends Error {
  readonly code: SafeUrlError;
  readonly hostname: string;
  constructor(code: SafeUrlError, hostname: string, message?: string) {
    super(message ?? `${code}: ${hostname}`);
    this.name = 'UnsafeUrlError';
    this.code = code;
    this.hostname = hostname;
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

const BLOCKED_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^.+-db$/i,
  /^.+-staging-db$/i,
  /^.+-prod-db$/i,
  /^.+-internal$/i,
  /\.internal$/i,
  /\.local$/i,
  /^host\.docker\.internal$/i,
  /^gateway\.docker\.internal$/i,
];

function normaliseIPv4Decimal(host: string): string | null {
  if (!/^\d+$/.test(host)) return null;
  // 32-bit IPv4 max = 4_294_967_295 < Number.MAX_SAFE_INTEGER → Number is safe.
  const n = Number(host);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  const a = Math.floor(n / 0x1000000) & 0xff;
  const b = Math.floor(n / 0x10000) & 0xff;
  const c = Math.floor(n / 0x100) & 0xff;
  const d = n & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function normaliseIPv4Hex(host: string): string | null {
  if (!/^0x[0-9a-f]+$/i.test(host)) return null;
  const n = parseInt(host, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  const a = (n >> 24) & 0xff;
  const b = (n >> 16) & 0xff;
  const c = (n >> 8) & 0xff;
  const d = n & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function normaliseIPv4Octal(host: string): string | null {
  if (!/^(0\d+\.){3}0?\d+$/.test(host)) return null;
  const parts = host.split('.').map((p) => parseInt(p, 8));
  if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 0xff)) return null;
  return parts.join('.');
}

function normaliseHostname(rawHost: string): string {
  const host = rawHost.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    return isIPv6(inner) ? inner : inner;
  }
  if (isIPv4(host) || isIPv6(host)) return host;

  const dec = normaliseIPv4Decimal(host);
  if (dec) return dec;

  const hex = normaliseIPv4Hex(host);
  if (hex) return hex;

  const oct = normaliseIPv4Octal(host);
  if (oct) return oct;

  return host;
}

function classifyIPv4(ip: string): SafeUrlError | null {
  const [a, b] = ip.split('.').map((s) => parseInt(s, 10));
  if (a === 0) return 'unspecified_ipv4';
  if (a === 127) return 'loopback_ipv4';
  if (a === 10) return 'private_ipv4';
  if (a === 172 && b >= 16 && b <= 31) return 'private_ipv4';
  if (a === 192 && b === 168) return 'private_ipv4';
  if (a === 169 && b === 254) return 'link_local_ipv4';
  if (a === 100 && b >= 64 && b <= 127) return 'private_ipv4';
  if (a >= 224) return 'broadcast_ipv4';
  return null;
}

function ipv4MappedTail(ip: string): string | null {
  const lower = ip.toLowerCase();
  // dot-decimal form, e.g. ::ffff:127.0.0.1
  const dotMatch = lower.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotMatch && isIPv4(dotMatch[1])) return dotMatch[1];
  // hex pair form (canonical from new URL), e.g. ::ffff:7f00:1
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return null;
}

function classifyIPv6(ip: string): SafeUrlError | null {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'unspecified_ipv6';
  if (
    lower === '::1' ||
    lower === '0:0:0:0:0:0:0:1' ||
    /^0{0,4}(:0{0,4}){6}:0{0,3}1$/.test(lower)
  ) {
    return 'loopback_ipv6';
  }
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return 'link_local_ipv6';
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return 'unique_local_ipv6';
  // IPv4-mapped IPv6 — re-classify against the embedded IPv4 ranges
  const v4 = ipv4MappedTail(lower);
  if (v4) {
    const cls = classifyIPv4(v4);
    if (cls) return 'ipv4_mapped_ipv6';
  }
  return null;
}

/**
 * Throws UnsafeUrlError when the URL is not safe to expose / redirect to /
 * persist as a callback target. Returns the parsed URL on success so callers
 * can use the normalised form.
 */
export function assertPublicHttpUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new UnsafeUrlError('invalid_url', String(input ?? ''), 'empty or non-string input');
  }
  const trimmed = input.trim();
  if (/[\s\x00-\x1f]/.test(trimmed)) {
    throw new UnsafeUrlError('invalid_url', trimmed, 'whitespace or control char in URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UnsafeUrlError('invalid_url', trimmed);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new UnsafeUrlError('invalid_scheme', parsed.protocol, `scheme ${parsed.protocol} not allowed`);
  }
  if (!parsed.hostname) {
    throw new UnsafeUrlError('empty_hostname', '', 'missing hostname');
  }

  const normalised = normaliseHostname(parsed.hostname);

  for (const pat of BLOCKED_HOSTNAME_PATTERNS) {
    if (pat.test(normalised)) {
      throw new UnsafeUrlError('blocked_hostname', normalised);
    }
  }

  const kind = isIP(normalised);
  if (kind === 4) {
    const cls = classifyIPv4(normalised);
    if (cls) throw new UnsafeUrlError(cls, normalised);
  } else if (kind === 6) {
    const cls = classifyIPv6(normalised);
    if (cls) throw new UnsafeUrlError(cls, normalised);
  }

  return parsed;
}

/**
 * Boolean variant for Zod refine() / quick checks. Never throws.
 */
export function isPublicHttpUrl(input: unknown): boolean {
  try {
    assertPublicHttpUrl(input);
    return true;
  } catch {
    return false;
  }
}

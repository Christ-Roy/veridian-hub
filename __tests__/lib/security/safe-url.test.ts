/**
 * Anti-SSRF helper unit tests — covers normalised hostname classification.
 * Mirrors the payloads in `e2e/staging-full/mega/I-security/I-03-ssrf-external-urls.spec.ts`
 * plus a wider battery of encoding bypasses.
 */

import { describe, it, expect } from 'vitest';

import { assertPublicHttpUrl, isPublicHttpUrl, UnsafeUrlError } from '@/lib/security/safe-url';

describe('assertPublicHttpUrl — accept golden paths', () => {
  const PUBLIC_OK = [
    'https://veridian.site/',
    'https://hub.veridian.site/dashboard',
    'https://prospection.app.veridian.site/api/healthcheck',
    'http://example.com/',
    'https://example.com:8443/path?query=1#frag',
    'https://93.184.216.34/',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/',
    'https://sub.domain.with-dashes.example.org/long/path',
  ];
  for (const url of PUBLIC_OK) {
    it(`accepts ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).not.toThrow();
      expect(isPublicHttpUrl(url)).toBe(true);
    });
  }
});

describe('assertPublicHttpUrl — reject cloud metadata IPs', () => {
  const META = [
    'http://169.254.169.254/',
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/',
    'https://[fe80::1]/',
  ];
  for (const url of META) {
    it(`rejects metadata ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UnsafeUrlError);
      expect(isPublicHttpUrl(url)).toBe(false);
    });
  }
});

describe('assertPublicHttpUrl — reject loopback', () => {
  const LOOP = [
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://localhost/',
    'http://LOCALHOST:6379/',
    'http://[::1]/',
    'http://[0:0:0:0:0:0:0:1]/',
  ];
  for (const url of LOOP) {
    it(`rejects loopback ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UnsafeUrlError);
    });
  }
});

describe('assertPublicHttpUrl — reject RFC1918 private nets', () => {
  const PRIVATE = [
    'http://10.0.0.1/',
    'http://10.255.255.254/',
    'http://172.16.0.1/',
    'http://172.20.5.5/',
    'http://172.31.255.254/',
    'http://192.168.0.1/',
    'http://192.168.1.1:8080/',
    'http://100.64.0.1/', // CGNAT
  ];
  for (const url of PRIVATE) {
    it(`rejects private ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UnsafeUrlError);
    });
  }
});

describe('assertPublicHttpUrl — reject encoding bypasses', () => {
  it('rejects IPv4 in decimal notation (169.254.169.254 = 2852039166)', () => {
    expect(() => assertPublicHttpUrl('http://2852039166/')).toThrow(UnsafeUrlError);
  });
  it('rejects IPv4 in hex notation (127.0.0.1 = 0x7f000001)', () => {
    expect(() => assertPublicHttpUrl('http://0x7f000001/')).toThrow(UnsafeUrlError);
  });
  it('rejects IPv4 in octal notation (127.0.0.1 = 0177.0.0.01)', () => {
    expect(() => assertPublicHttpUrl('http://0177.0.0.01/')).toThrow(UnsafeUrlError);
  });
  it('rejects URL-encoded loopback', () => {
    expect(() => assertPublicHttpUrl('http://%31%32%37.0.0.1/')).toThrow(UnsafeUrlError);
  });
  it('rejects IPv6 longhand loopback', () => {
    expect(() => assertPublicHttpUrl('http://[0:0:0:0:0:0:0:1]/')).toThrow(UnsafeUrlError);
  });
  it('rejects IPv4-mapped IPv6 loopback', () => {
    expect(() => assertPublicHttpUrl('http://[::ffff:127.0.0.1]/')).toThrow(UnsafeUrlError);
  });
});

describe('assertPublicHttpUrl — reject dangerous schemes', () => {
  const BAD_SCHEME = [
    'file:///etc/passwd',
    'file:///etc/shadow',
    'javascript:alert(1)',
    'javascript:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'gopher://localhost:6379/_FLUSHALL',
    'ftp://example.com/',
    'ws://example.com/',
    'wss://example.com/',
  ];
  for (const url of BAD_SCHEME) {
    it(`rejects scheme ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UnsafeUrlError);
    });
  }
});

describe('assertPublicHttpUrl — reject Docker internal hostnames', () => {
  const DOCKER = [
    'http://hub-staging-db:5432/',
    'http://notifuse-staging-db:5432/',
    'http://prospection-prod-db:5432/',
    'http://something-internal/',
    'http://host.docker.internal:3000/',
    'http://gateway.docker.internal:3000/',
    'http://my-service.local/',
    'http://api.internal/',
  ];
  for (const url of DOCKER) {
    it(`rejects docker hostname ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UnsafeUrlError);
    });
  }
});

describe('assertPublicHttpUrl — reject malformed / empty / control chars', () => {
  const BAD = ['', '   ', 'not-a-url', '//169.254.169.254/', '\\\\169.254.169.254\\share'];
  for (const url of BAD) {
    it(`rejects malformed "${url.slice(0, 30)}"`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow(UnsafeUrlError);
    });
  }
  it('rejects non-string input', () => {
    expect(() => assertPublicHttpUrl(undefined)).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpUrl(null)).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpUrl(123)).toThrow(UnsafeUrlError);
    expect(() => assertPublicHttpUrl({ url: 'https://example.com/' })).toThrow(UnsafeUrlError);
  });
  it('rejects URL with embedded CRLF', () => {
    expect(() => assertPublicHttpUrl('http://example.com/\r\nHost: evil.com')).toThrow(UnsafeUrlError);
  });
});

describe('assertPublicHttpUrl — reject unspecified / broadcast', () => {
  it('rejects 0.0.0.0', () => {
    expect(() => assertPublicHttpUrl('http://0.0.0.0/')).toThrow(UnsafeUrlError);
  });
  it('rejects IPv6 unspecified ::', () => {
    expect(() => assertPublicHttpUrl('http://[::]/')).toThrow(UnsafeUrlError);
  });
  it('rejects multicast 239.x.x.x', () => {
    expect(() => assertPublicHttpUrl('http://239.255.255.250/')).toThrow(UnsafeUrlError);
  });
});

describe('assertPublicHttpUrl — error metadata', () => {
  it('throws UnsafeUrlError with stable code for cloud metadata', () => {
    try {
      assertPublicHttpUrl('http://169.254.169.254/');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeUrlError);
      const e = err as UnsafeUrlError;
      expect(e.code).toBe('link_local_ipv4');
      expect(e.hostname).toBe('169.254.169.254');
    }
  });
  it('throws UnsafeUrlError with code invalid_scheme on file:', () => {
    try {
      assertPublicHttpUrl('file:///etc/passwd');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeUrlError);
      expect((err as UnsafeUrlError).code).toBe('invalid_scheme');
    }
  });
  it('throws UnsafeUrlError with code blocked_hostname for hub-staging-db', () => {
    try {
      assertPublicHttpUrl('http://hub-staging-db:5432/');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeUrlError);
      expect((err as UnsafeUrlError).code).toBe('blocked_hostname');
    }
  });
});

describe('isPublicHttpUrl — boolean variant never throws', () => {
  it('returns false for any garbage', () => {
    expect(isPublicHttpUrl(undefined)).toBe(false);
    expect(isPublicHttpUrl(null)).toBe(false);
    expect(isPublicHttpUrl('')).toBe(false);
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isPublicHttpUrl('http://169.254.169.254/')).toBe(false);
  });
  it('returns true for legitimate URLs', () => {
    expect(isPublicHttpUrl('https://veridian.site/')).toBe(true);
    expect(isPublicHttpUrl('http://api.example.com/v1/foo')).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv } from '../../server/config';

afterEach(() => vi.unstubAllEnvs());

describe('production listener configuration', () => {
  it('accepts a Tailscale origin only with a loopback listener', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ORIGIN', 'https://stillroom.example.ts.net');
    vi.stubEnv('HOST', '127.0.0.1');
    expect(configFromEnv()).toMatchObject({
      host: '127.0.0.1',
      rpID: 'stillroom.example.ts.net',
      production: true,
    });
    for (const host of ['0.0.0.0', '::', '172.18.0.2']) {
      vi.stubEnv('HOST', host);
      expect(() => configFromEnv()).toThrow('must bind');
    }
  });
  it('fails closed before the HTTPS origin is configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HOST', '127.0.0.1');
    for (const origin of [
      '',
      'http://stillroom.example.ts.net',
      'https://example.com',
      'https://stillroom.example.ts.net:3000',
    ]) {
      vi.stubEnv('APP_ORIGIN', origin);
      expect(() => configFromEnv()).toThrow('Production requires');
    }
  });
});

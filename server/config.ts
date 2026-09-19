import { resolve } from 'node:path';

export type Config = {
  origin: string;
  rpID: string;
  dataDir: string;
  production: boolean;
  host: string;
  bootstrapToken?: string;
  staticDir?: string;
};

export function configFromEnv(): Config {
  const production = process.env.NODE_ENV === 'production';
  const url = new URL(process.env.APP_ORIGIN || 'http://localhost:5173');
  if (url.origin !== (process.env.APP_ORIGIN || 'http://localhost:5173'))
    throw new Error('APP_ORIGIN must be an origin without a trailing slash.');
  const host = process.env.HOST || '127.0.0.1';
  if (production && (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.port)) {
    throw new Error('Production requires the full HTTPS Tailscale APP_ORIGIN without a port.');
  }
  if (production && host !== '127.0.0.1')
    throw new Error('Production must bind to 127.0.0.1 inside the Tailscale network namespace.');
  if (!production && !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Development is restricted to localhost.');
  return {
    origin: url.origin,
    rpID: url.hostname,
    production,
    host,
    dataDir: resolve(process.env.DATA_DIR || 'data'),
    staticDir: resolve('dist'),
  };
}

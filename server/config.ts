import { resolve } from 'node:path';

export type Config = {
  origin: string;
  rpID: string;
  dataDir: string;
  production: boolean;
  proxySecret: string;
  bootstrapToken?: string;
  staticDir?: string;
};

export function configFromEnv(): Config {
  const production = process.env.NODE_ENV === 'production';
  const url = new URL(process.env.APP_ORIGIN || 'http://localhost:5173');
  if (url.origin !== (process.env.APP_ORIGIN || 'http://localhost:5173'))
    throw new Error('APP_ORIGIN must be an origin without a trailing slash.');
  const proxySecret = process.env.PROXY_SECRET || '';
  if (production && (url.protocol !== 'https:' || proxySecret.length < 32)) {
    throw new Error(
      'Production requires an HTTPS APP_ORIGIN and a PROXY_SECRET of at least 32 characters.',
    );
  }
  if (!production && !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Development is restricted to localhost.');
  return {
    origin: url.origin,
    rpID: url.hostname,
    production,
    proxySecret,
    dataDir: resolve(process.env.DATA_DIR || 'data'),
    staticDir: resolve('dist'),
  };
}
